import axios from "axios";
import * as fs from "fs";
import { Chain } from "../types/chain";
import {
  CHAINS_WITH_ETHSCAN_BASED_EXPLORERS,
  DATA_DIRECTORY,
  LOG_LEVEL,
} from "../utils/config";
import * as path from "path";
import { makeDataDirRecursive } from "./make-data-dir-recursive";
import { normalizeAddress } from "../utils/ethers";
import {
  ContractCreationInfo,
  fetchContractFirstLastTrxFromExplorer,
  getContractCreationInfosFromRPC,
} from "./contract-transaction-infos";
import { cacheAsyncResultInRedis } from "../utils/cache";
import { getRedlock } from "./shared-resources/shared-lock";
import { backOff } from "exponential-backoff";
import { logger } from "../utils/logger";
import {
  BeefyFeeRecipientInfo,
  fetchBeefyStrategyFeeRecipients,
} from "../lib/strategy-fee-recipient-infos";
import {
  BeefyVault,
  getAllVaultsFromGitHistory,
} from "../lib/git-get-all-vaults";

function fetchIfNotFoundLocally<TRes, TArgs extends any[]>(
  doFetch: (...parameters: TArgs) => Promise<TRes>,
  getLocalPath: (...parameters: TArgs) => string,
  options?: {
    ttl_ms?: number;
    getResourceId?: (...parameters: TArgs) => string;
    doWrite?: (data: TRes, filePath: string) => Promise<TRes>;
    doRead?: (filePath: string) => Promise<TRes>;
  }
) {
  // set default options
  const doWrite =
    options?.doWrite ||
    (async (data: TRes, filePath: string) => {
      await fs.promises.writeFile(filePath, JSON.stringify(data));
      return data;
    });
  const doRead =
    options?.doRead ||
    (async (filePath) => {
      const content = await fs.promises.readFile(filePath, "utf8");
      const data = JSON.parse(content);
      return data;
    });
  const getResourceId =
    options?.getResourceId ||
    (() => "fetchIfNotFoundLocally:" + Math.random().toString());

  const ttl = options?.ttl_ms || null;
  return async function (...parameters: TArgs): Promise<TRes> {
    const localPath = getLocalPath(...parameters);

    if (fs.existsSync(localPath)) {
      // resolve ttl
      let shouldServeCache = true;
      if (ttl !== null) {
        const now = new Date();
        const localStat = await fs.promises.stat(localPath);
        const lastModifiedDate = localStat.mtime;
        if (now.getTime() - lastModifiedDate.getTime() > ttl) {
          shouldServeCache = false;
        }
      }

      if (shouldServeCache) {
        logger.debug(
          `[FETCH] Local cache file exists and is not expired, returning it's content`
        );
        return doRead(localPath);
      } else {
        logger.debug(`[FETCH] Local cache file exists but is expired`);
      }
    }

    const redlock = await getRedlock();
    const resourceId = "fetch:" + getResourceId(...parameters);
    try {
      const data = await backOff(
        () =>
          redlock.using([resourceId], 2 * 60 * 1000, async () =>
            doFetch(...parameters)
          ),
        {
          delayFirstAttempt: false,
          jitter: "full",
          maxDelay: 5 * 60 * 1000,
          numOfAttempts: 10,
          retry: (error, attemptNumber) => {
            const message = `[FETCH] Error on attempt ${attemptNumber} fetching ${resourceId}: ${error.message}`;
            if (attemptNumber < 3) logger.verbose(message);
            else if (attemptNumber < 5) logger.info(message);
            else if (attemptNumber < 8) logger.warn(message);
            else logger.error(message);

            if (LOG_LEVEL === "trace") {
              console.error(error);
            }
            return true;
          },
          startingDelay: 200,
          timeMultiple: 2,
        }
      );
      logger.debug(
        `[FETCH] Got new data for ${resourceId}, writing it and returning it`
      );
      await makeDataDirRecursive(localPath);

      return doWrite(data, localPath);
    } catch (error) {
      if (fs.existsSync(localPath)) {
        logger.warn(
          `[FETCH] Could not reload local data after ttl expired: ${resourceId}. Serving local data anyway. ${JSON.stringify(
            error
          )}`
        );
        return doRead(localPath);
      } else {
        throw error;
      }
    }
  };
}

export const fetchBeefyVaultList = fetchIfNotFoundLocally(
  async (chain: Chain) => {
    logger.info(`[FETCH] Fetching updated vault list for ${chain}`);

    return getAllVaultsFromGitHistory(chain);
  },
  (chain: Chain) =>
    path.join(DATA_DIRECTORY, "chain", chain, "beefy", "vaults.jsonl"),
  {
    ttl_ms: 1000 * 60 * 60 * 24,
    getResourceId: (chain: Chain) => `vault-list:${chain}`,
    doWrite: async (data, filePath) => {
      const jsonl = data.map((obj) => JSON.stringify(obj)).join("\n");
      await fs.promises.writeFile(filePath, jsonl);
      return data;
    },
    doRead: async (filePath) => {
      const content = await fs.promises.readFile(filePath, "utf8");
      const data = content.split("\n").map((obj) => JSON.parse(obj));
      return data;
    },
  }
);

export async function getLocalBeefyVaultList(
  chain: Chain
): Promise<BeefyVault[]> {
  const filePath = path.join(
    DATA_DIRECTORY,
    "chain",
    chain,
    "beefy",
    "vaults.jsonl"
  );
  if (!fs.existsSync(filePath)) {
    return [];
  }
  let content = await fs.promises.readFile(filePath, "utf8");
  content = content.trim();
  if (content === "") {
    return [];
  }
  const vaults = content.split("\n").map((obj) => JSON.parse(obj));
  return Object.values(vaults);
}

export const fetchContractCreationInfos = fetchIfNotFoundLocally(
  async (
    chain: Chain,
    contractAddress: string
  ): Promise<ContractCreationInfo> => {
    const useExplorer = CHAINS_WITH_ETHSCAN_BASED_EXPLORERS.includes(chain);
    if (useExplorer) {
      return fetchContractFirstLastTrxFromExplorer(
        chain,
        contractAddress,
        "first"
      );
    } else {
      const creationInfos = await getContractCreationInfosFromRPC(
        chain,
        contractAddress,
        "4hour"
      );
      if (!creationInfos) {
        throw new Error(
          `Could not find contract creation block for ${contractAddress} on ${chain}`
        );
      }
      return creationInfos;
    }
  },
  (chain: Chain, contractAddress: string) =>
    path.join(
      DATA_DIRECTORY,
      "chain",
      chain,
      "contracts",
      normalizeAddress(contractAddress),
      "creation_date.json"
    ),
  {
    getResourceId: (chain: Chain, contractAddress: string) =>
      `${chain}:${contractAddress}:creation_date`,
  }
);

export async function getLocalContractCreationInfos(
  chain: Chain,
  contractAddress: string
): Promise<ContractCreationInfo | null> {
  const filePath = path.join(
    DATA_DIRECTORY,
    "chain",
    chain,
    "contracts",
    normalizeAddress(contractAddress),
    "creation_date.json"
  );
  if (!fs.existsSync(filePath)) {
    return null;
  }
  let content = await fs.promises.readFile(filePath, "utf8");
  content = content.trim();
  if (content === "") {
    return null;
  }
  const data = JSON.parse(content);
  data.datetime = new Date(data.datetime);
  return data;
}

export const fetchCachedContractLastTransaction = cacheAsyncResultInRedis(
  async (
    chain: Chain,
    contractAddress: string
  ): Promise<ContractCreationInfo> => {
    return fetchContractFirstLastTrxFromExplorer(
      chain,
      contractAddress,
      "last"
    );
  },
  {
    getKey: (chain: Chain, contractAddress: string) =>
      `${chain}:${contractAddress}:last-trx`,
    dateFields: ["datetime"],
    ttl_sec: 60 * 60,
  }
);

export const getBeefyStrategyFeeRecipients = fetchIfNotFoundLocally(
  async (
    chain: Chain,
    contractAddress: string
  ): Promise<BeefyFeeRecipientInfo> => {
    return fetchBeefyStrategyFeeRecipients(chain, contractAddress);
  },
  (chain: Chain, contractAddress: string) =>
    path.join(
      DATA_DIRECTORY,
      "chain",
      chain,
      "contracts",
      normalizeAddress(contractAddress),
      "fee_recipients.json"
    ),
  {
    getResourceId: (chain: Chain, contractAddress: string) =>
      `${chain}:${contractAddress}:fee_recipients`,
  }
);

export async function getLocalBeefyStrategyFeeRecipients(
  chain: Chain,
  contractAddress: string
): Promise<BeefyFeeRecipientInfo | null> {
  const filePath = path.join(
    DATA_DIRECTORY,
    "chain",
    chain,
    "contracts",
    normalizeAddress(contractAddress),
    "fee_recipients.json"
  );
  if (!fs.existsSync(filePath)) {
    return null;
  }
  let content = await fs.promises.readFile(filePath, "utf8");
  content = content.trim();
  if (content === "") {
    return null;
  }
  const data = JSON.parse(content);
  return data;
}
