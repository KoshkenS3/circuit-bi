import { logger } from "../utils/logger";
import {
  insertErc20TransferBatch,
  prepareInsertErc20TransferBatch,
} from "../utils/db";
import { streamBifiVaultUpgradeStratEventsFromRpc } from "../lib/streamContractEventsFromRpc";
import { getContract } from "../utils/ethers";
import BeefyVaultV6Abi from "../../data/interfaces/beefy/BeefyVaultV6/BeefyVaultV6.json";
import _ERC20Abi from "../../data/interfaces/standard/ERC20.json";
import { ethers } from "ethers";
import { ERC20EventData } from "../lib/csv-transfer-events";
import * as lodash from "lodash";
import { Chain } from "../types/chain";
import { EXPLORER_URLS } from "../utils/config";
import axios from "axios";
import { sleep } from "../utils/async";
import { batchAsyncStream } from "../utils/batch";

const ERC20Abi = _ERC20Abi as any as JsonAbi;

async function main() {
  const chain = "bsc";
  //const contractAddress = "0x07fFC2258c99e6667235fEAa90De35A0a50CFBFd";
  const contractAddress = "0x7828ff4aba7aab932d8407c78324b069d24284c9";
  const eventStream = streamERC20TransferEventsFromExplorer(
    chain,
    contractAddress,
    0
  );
  for await (const eventBatch of batchAsyncStream(eventStream, 100)) {
    console.log(eventBatch.length);
  }
  return;

  const contract = getContract(chain, BeefyVaultV6Abi, contractAddress);
  const eventFilter = contract.filters.Transfer();
  const events = await contract.queryFilter(eventFilter);
  console.log(events);
}

type JsonAbi = {
  inputs?: {
    internalType: string;
    name: string;
    type: string;
    indexed?: boolean;
  }[];
  stateMutability?: string;
  type: string;
  anonymous?: boolean;
  name?: string;
  outputs?: {
    internalType: string;
    name: string;
    type: string;
  }[];
}[];

interface ExplorerLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  timeStamp: number;
  gasPrice: number;
  gasUsed: number;
  logIndex: number;
  transactionHash: string;
  transactionIndex: number;
}

// be nice to explorers or you'll get banned
const minMsBetweenCalls = 6000;
let lastCall = new Date(0);
async function fetchExplorerLogsPage<TRes extends { blockNumber: number }>(
  chain: Chain,
  contractAddress: string,
  abi: JsonAbi,
  eventName: string,
  fromBlock: number,
  formatEvent: (event: ExplorerLog) => TRes
) {
  const eventTopic = getEventTopicFromJsonAbi(abi, eventName);
  const explorerUrl =
    EXPLORER_URLS[chain] +
    `?module=logs&action=getLogs&address=${contractAddress}&topic0=${eventTopic}&fromBlock=${fromBlock}`;
  const now = new Date();
  if (now.getTime() - lastCall.getTime() < minMsBetweenCalls) {
    await sleep(minMsBetweenCalls - (now.getTime() - lastCall.getTime()));
  }
  const response = await axios.get<{ result: ExplorerLog[] }>(explorerUrl);
  lastCall = new Date();
  let logs = response.data.result.map(formatEvent);
  const mayHaveMore = logs.length === 1000;
  // remove last block data as the explorer may have truncated results
  // in the middle of a block
  if (mayHaveMore) {
    const lastLogBlock = logs[logs.length - 1];
    for (let i = logs.length - 1; i >= 0; i--) {
      if (logs[i].blockNumber === lastLogBlock.blockNumber) {
        logs.pop();
      } else {
        break;
      }
    }
  }
  return { logs, mayHaveMore };
}

const getEventTopicFromJsonAbi = lodash.memoize(
  function _getEventTopicFromJsonAbi(abi: JsonAbi, eventName: string) {
    const eventTypes = getEventTypesFromJsonAbi(abi, eventName);
    return ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(`${eventName}(${eventTypes.join(",")})`)
    );
  }
);

const getEventTypesFromJsonAbi = lodash.memoize(
  function _getEventTypesFromJsonAbi(abi: JsonAbi, eventName: string) {
    const eventConfig = abi.find(
      (abi) => abi.name === eventName && abi.type === "event"
    );
    if (!eventConfig || !eventConfig.inputs) {
      throw new Error(`${eventName} not found in abi`);
    }
    return eventConfig.inputs.map((input) => input.type);
  }
);

function explorerLogToERC20TransferEvent(event: ExplorerLog): ERC20EventData {
  const blockNumber = parseInt(
    ethers.BigNumber.from(event.blockNumber).toString()
  );
  const data =
    "0x" +
    event.topics
      .slice(1)
      .concat([event.data])
      .map((hexData: string) => hexData.slice(2))
      .join("");
  const [from, to, value] = ethers.utils.defaultAbiCoder.decode(
    getEventTypesFromJsonAbi(ERC20Abi, "Transfer"),
    data
  );
  return {
    blockNumber,
    from,
    to,
    value: value.toString(),
  };
}

async function* streamERC20TransferEventsFromExplorer(
  chain: Chain,
  contractAddress: string,
  fromBlock: number
) {
  let mayHaveMore = true;
  while (mayHaveMore) {
    const pageRes = await fetchExplorerLogsPage(
      chain,
      contractAddress,
      ERC20Abi,
      "Transfer",
      fromBlock,
      explorerLogToERC20TransferEvent
    );
    if (pageRes.logs.length === 0) {
      return;
    }
    yield* pageRes.logs;
    mayHaveMore = pageRes.mayHaveMore;
    fromBlock = pageRes.logs[pageRes.logs.length - 1].blockNumber + 1;
  }
}

main()
  .then(() => {
    logger.info("Done");
    process.exit(0);
  })
  .catch((e) => {
    console.log(e);
    logger.error(e);
    process.exit(1);
  });
