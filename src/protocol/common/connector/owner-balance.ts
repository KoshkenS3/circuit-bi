import * as Rx from "rxjs";
import ERC20Abi from "../../../../data/interfaces/standard/ERC20.json";
import { ethers } from "ethers";
import { Decimal } from "decimal.js";
import { Chain } from "../../../types/chain";
import { BatchStreamConfig, batchRpcCalls$ } from "../utils/batch-rpc-calls";
import { DbProduct } from "../loader/product";
import { ErrorEmitter, ProductImportQuery } from "../types/product-query";
import { RpcConfig } from "../../../types/rpc-config";

interface GetBalanceCallParams {
  contractAddress: string;
  decimals: number;
  ownerAddress: string;
  blockNumber: number;
}

export function fetchERC20TokenBalance$<
  TProduct extends DbProduct,
  TObj extends ProductImportQuery<TProduct>,
  TParams extends GetBalanceCallParams,
  TRes extends ProductImportQuery<TProduct>,
>(options: {
  rpcConfig: RpcConfig;
  chain: Chain;
  getQueryParams: (obj: TObj) => TParams;
  emitErrors: ErrorEmitter;
  streamConfig: BatchStreamConfig;
  formatOutput: (obj: TObj, balance: Decimal) => TRes;
}): Rx.OperatorFunction<TObj, TRes> {
  return batchRpcCalls$({
    rpcConfig: options.rpcConfig,
    streamConfig: options.streamConfig,
    logInfos: { msg: "Fetching ERC20 token balance", data: {} },
    emitErrors: options.emitErrors,
    formatOutput: options.formatOutput,
    getQuery: options.getQueryParams,
    processBatch: async (params: TParams[]) => {
      const balancePromises: Promise<Decimal>[] = [];
      for (const param of params) {
        const valueMultiplier = new Decimal(10).pow(-param.decimals);
        const contract = new ethers.Contract(param.contractAddress, ERC20Abi, options.rpcConfig.batchProvider);

        // aurora RPC return the state before the transaction is applied
        let blockTag = param.blockNumber;
        if (options.chain === "aurora") {
          blockTag = param.blockNumber + 1;
        }

        const balancePromise = contract
          .balanceOf(param.ownerAddress, { blockTag })
          .then((balance: ethers.BigNumber) => valueMultiplier.mul(balance.toString() ?? "0"));
        balancePromises.push(balancePromise);
      }
      return Promise.all(balancePromises);
    },
  });
}
