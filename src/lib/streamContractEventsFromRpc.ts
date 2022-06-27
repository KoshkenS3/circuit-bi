import { Chain } from "../types/chain";
import { logger } from "../utils/logger";
import * as lodash from "lodash";
import ERC20Abi from "../../data/interfaces/standard/ERC20.json";
import BeefyVaultV6Abi from "../../data/interfaces/beefy/BeefyVaultV6/BeefyVaultV6.json";
import { ethers } from "ethers";
import { CHAIN_RPC_MAX_QUERY_BLOCKS } from "../utils/config";
import {
  ArchiveNodeNeededError,
  callLockProtectedRpc,
  isErrorDueToMissingDataFromNode,
} from "./shared-resources/shared-rpc";
import {
  fetchCachedContractLastTransaction,
  fetchContractCreationInfos,
} from "./fetch-if-not-found-locally";
import axios from "axios";
import { isNumber } from "lodash";

async function* streamContractEventsFromRpc<TEventArgs>(
  chain: Chain,
  contractAddress: string,
  abi: ethers.ContractInterface,
  eventName: string,
  options?: {
    startBlock?: number;
    endBlock?: number;
    blockBatchSize?: number;
    mapArgs?: (args: ethers.utils.Result) => TEventArgs;
    getEventFilters?: (
      filters: ethers.BaseContract["filters"]
    ) => ethers.EventFilter;
    timeOrder?: "timeline" | "reverse";
  }
) {
  let startBlock = options?.startBlock;
  if (!startBlock) {
    const { blockNumber } = await fetchContractCreationInfos(
      chain,
      contractAddress
    );
    startBlock = blockNumber;
  }
  let endBlock = options?.endBlock;
  if (!endBlock) {
    const { blockNumber } = await fetchCachedContractLastTransaction(
      chain,
      contractAddress
    );
    endBlock = blockNumber;
  }

  // we will need to call the contract to get the ppfs at some point
  const mapArgs = options?.mapArgs || ((x) => x as any as TEventArgs);

  // iterate through block ranges
  const rangeSize =
    options?.blockBatchSize || CHAIN_RPC_MAX_QUERY_BLOCKS[chain]; // big to speed up, not to big to avoid rpc limitations
  const flat_range = lodash.range(startBlock, endBlock + 1, rangeSize);
  flat_range.push(endBlock + 1); // to make sure we get the last block
  let ranges: { fromBlock: number; toBlock: number }[] = [];
  for (let i = 0; i < flat_range.length - 1; i++) {
    ranges.push({
      fromBlock: flat_range[i],
      toBlock: flat_range[i + 1] - 1,
    });
  }
  if (options?.timeOrder === "reverse") {
    ranges = ranges.reverse();
  }
  logger.verbose(
    `[ERC20.T.RPC] Iterating through ${ranges.length} ranges for ${chain}:${contractAddress}:${eventName}`
  );
  for (const [rangeIdx, blockRange] of ranges.entries()) {
    logger.debug(
      `[ERC20.T.RPC] Fetching ERC20 event batch for ${chain}:${contractAddress} (${blockRange.fromBlock} -> ${blockRange.toBlock})`
    );
    const events = await callLockProtectedRpc(chain, async (provider) => {
      // instanciate contract late to shuffle rpcs on error
      const contract = new ethers.Contract(contractAddress, abi, provider);
      const eventFilter = options?.getEventFilters
        ? options?.getEventFilters(contract.filters)
        : contract.filters[eventName]();
      return contract.queryFilter(
        eventFilter,
        blockRange.fromBlock,
        blockRange.toBlock
      );
    });

    if (events.length > 0) {
      logger.verbose(
        `[ERC20.T.RPC] Got ${events.length} events for range ${rangeIdx}/${ranges.length}`
      );
    } else {
      logger.debug(
        `[ERC20.T.RPC] No events for range ${rangeIdx}/${ranges.length}`
      );
    }

    for (const rawEvent of events) {
      if (!rawEvent.args) {
        throw new Error(`No event args in event ${rawEvent}`);
      }
      const mappedEvent = {
        blockNumber: rawEvent.blockNumber,
        datetime: new Date((await rawEvent.getBlock()).timestamp * 1000),
        data: mapArgs(rawEvent.args),
      };
      yield mappedEvent;
    }
  }
}

export const streamERC20TransferEventsFromRpc = (
  chain: Chain,
  contractAddress: string,
  options?: {
    from?: string;
    to?: string;
    startBlock?: number;
    endBlock?: number;
    blockBatchSize?: number;
    timeOrder?: "timeline" | "reverse";
  }
) => {
  logger.debug(
    `[ERC20.T.RPC] Streaming ERC20 transfer events for ${chain}:${contractAddress} ${JSON.stringify(
      options
    )}`
  );
  return streamContractEventsFromRpc<{
    from: string;
    to: string;
    value: string;
  }>(chain, contractAddress, ERC20Abi, "Transfer", {
    getEventFilters: (filters) => {
      if (options?.from && options?.to) {
        return filters.Transfer(options.from, options.to);
      } else if (options?.from) {
        return filters.Transfer(options.from, null);
      } else if (options?.to) {
        return filters.Transfer(null, options.to);
      } else {
        return filters.Transfer();
      }
    },
    mapArgs: (args) => ({
      from: args.from,
      to: args.to,
      value: args.value.toString(),
    }),
    startBlock: options?.startBlock,
    endBlock: options?.endBlock,
    blockBatchSize: options?.blockBatchSize,
    timeOrder: options?.timeOrder,
  });
};

export async function* streamBifiVaultUpgradeStratEventsFromRpc(
  chain: Chain,
  contractAddress: string
) {
  // add a fake event for the contract creation
  const { blockNumber: deployBlockNumber, datetime: deployBlockDatetime } =
    await fetchContractCreationInfos(chain, contractAddress);
  logger.debug(
    `[BV6.VU.RPC] Fetching BeefyVaultV6 deploy strategy ${chain}:${contractAddress}:${deployBlockNumber}`
  );
  const firstStrategyRes = await getBeefyVaultV6StrategyAddress(
    chain,
    contractAddress,
    deployBlockNumber
  );
  yield {
    blockNumber: deployBlockNumber,
    datetime: deployBlockDatetime,
    data: { implementation: firstStrategyRes },
  };
  // add a shortcut if the strategy never changed
  logger.debug(
    `[BV6.VU.RPC] Fetching BeefyVaultV6 current strategy ${chain}:${contractAddress}`
  );
  const currentStrategyRes = await getBeefyVaultV6StrategyAddress(
    chain,
    contractAddress,
    "latest"
  );
  if (firstStrategyRes === currentStrategyRes) {
    logger.verbose(
      `[BV6.VU.RPC] Shortcut: no strategy change events for ${chain}:${contractAddress}`
    );
    return;
  }

  const eventStream = streamContractEventsFromRpc<{ implementation: string }>(
    chain,
    contractAddress,
    BeefyVaultV6Abi,
    "UpgradeStrat",
    {
      mapArgs: (args) => ({
        implementation: args.implementation,
      }),
    }
  );
  // just iteration to the event stream
  yield* eventStream;
}

async function getBeefyVaultV6StrategyAddress(
  chain: Chain,
  contractAddress: string,
  blockTag: ethers.providers.BlockTag | null
) {
  // it looks like ethers doesn't yet support harmony's special format or smth
  // same for heco
  if (chain === "harmony" || chain === "heco") {
    return fetchBeefyVaultV6StrategyWithManualRPCCall(
      chain,
      contractAddress,
      blockTag
    );
  }
  logger.debug(
    `[BV6.VU.RPC] Fetching strategy for ${chain}:${contractAddress}:${blockTag}`
  );
  return callLockProtectedRpc(chain, async (provider) => {
    const contract = new ethers.Contract(
      contractAddress,
      BeefyVaultV6Abi,
      provider
    );
    let strategyRes: [string];
    if (blockTag !== null) {
      strategyRes = await contract.functions.strategy({ blockTag });
    } else {
      strategyRes = await contract.functions.strategy();
    }
    return strategyRes[0];
  });
}

/**
 * I don't know why this is needed but seems like ethers.js is not doing the right rpc call
 */
async function fetchBeefyVaultV6StrategyWithManualRPCCall(
  chain: Chain,
  contractAddress: string,
  blockTag: ethers.providers.BlockTag | null
): Promise<string> {
  logger.debug(
    `[BV6.VU.RPC] Fetching strategy with manual rpc call for ${chain}:${contractAddress}:${blockTag}`
  );
  return callLockProtectedRpc(chain, async (provider) => {
    const url = provider.connection.url;

    // get the function call hash
    const abi = ["function strategy() view external returns (address)"];
    const iface = new ethers.utils.Interface(abi);
    const callData = iface.encodeFunctionData("strategy");

    // somehow block tag has to be hex encoded for heco
    const blockNumberHex =
      blockTag === null
        ? "latest"
        : isNumber(blockTag)
        ? ethers.utils.hexValue(blockTag)
        : ["earliest", "latest"].includes(blockTag)
        ? blockTag
        : ethers.utils.hexValue(blockTag);

    const res = await axios.post(url, {
      method: "eth_call",
      params: [
        {
          from: null,
          to: contractAddress,
          data: callData,
        },
        blockNumberHex,
      ],
      id: 1,
      jsonrpc: "2.0",
    });

    if (isErrorDueToMissingDataFromNode(res.data)) {
      throw new ArchiveNodeNeededError(chain, res.data);
    }
    const address = ethers.utils.defaultAbiCoder.decode(
      ["address"],
      res.data.result
    ) as any as [string];
    return address[0];
  });
}
