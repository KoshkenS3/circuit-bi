import { keyBy, uniqBy } from "lodash";
import * as Rx from "rxjs";
import { db_query } from "../../../utils/db";
import { ProgrammerError } from "../../../utils/programmer-error";
import { ErrorEmitter, ImportCtx } from "../types/import-context";
import { dbBatchCall$ } from "../utils/db-batch";

export interface DbPriceFeed {
  priceFeedId: number;
  feedKey: string;
  fromAssetKey: string;
  toAssetKey: string;
  priceFeedData: {
    externalId: string;
    active: boolean;
  };
}

export function upsertPriceFeed$<TObj, TErr extends ErrorEmitter<TObj>, TRes, TParams extends Omit<DbPriceFeed, "priceFeedId">>(options: {
  ctx: ImportCtx;
  emitError: TErr;
  getFeedData: (obj: TObj) => TParams;
  formatOutput: (obj: TObj, feed: DbPriceFeed) => TRes;
}) {
  return dbBatchCall$({
    ctx: options.ctx,
    emitError: options.emitError,
    formatOutput: options.formatOutput,
    getData: options.getFeedData,
    logInfos: { msg: "upsert price feed" },
    processBatch: async (objAndData) => {
      // select existing price feeds to update them instead of inserting new ones so we don't burn too much serial ids
      // More details: https://dba.stackexchange.com/a/295356/65636
      const existingPriceFeeds = await db_query<DbPriceFeed>(
        `SELECT price_feed_id as "priceFeedId", feed_key as "feedKey", from_asset_key as "fromAssetKey", to_asset_key as "toAssetKey", price_feed_data as "priceFeedData"
          FROM price_feed
          WHERE feed_key IN (%L)`,
        [objAndData.map((obj) => obj.data.feedKey)],
        options.ctx.client,
      );

      const existingPriceFeedByFeedKey = keyBy(existingPriceFeeds, (feed) => feed.feedKey);
      const priceFeedsToInsert = objAndData.filter((obj) => !existingPriceFeedByFeedKey[obj.data.feedKey]);
      const priceFeedsToUpdate = objAndData.filter((obj) => existingPriceFeedByFeedKey[obj.data.feedKey]);

      const insertResults =
        priceFeedsToInsert.length === 0
          ? []
          : await db_query<DbPriceFeed>(
              `INSERT INTO price_feed (feed_key, from_asset_key, to_asset_key, price_feed_data) VALUES %L
              ON CONFLICT (feed_key) 
              -- DO NOTHING -- can't use DO NOTHING because we need to return the id
              DO UPDATE SET
                from_asset_key = EXCLUDED.from_asset_key,
                to_asset_key = EXCLUDED.to_asset_key,
                price_feed_data = jsonb_merge(price_feed.price_feed_data, EXCLUDED.price_feed_data)
              RETURNING 
                price_feed_id as "priceFeedId", 
                feed_key as "feedKey",
                from_asset_key as "fromAssetKey",
                to_asset_key as "toAssetKey",
                price_feed_data as "priceFeedData"`,
              [
                uniqBy(priceFeedsToInsert, (obj) => obj.data.feedKey).map((obj) => [
                  obj.data.feedKey,
                  obj.data.fromAssetKey,
                  obj.data.toAssetKey,
                  obj.data.priceFeedData,
                ]),
              ],
              options.ctx.client,
            );

      const updateResults =
        priceFeedsToUpdate.length === 0
          ? []
          : await db_query<DbPriceFeed>(
              `UPDATE price_feed
              SET
                from_asset_key = u.from_asset_key,
                to_asset_key = u.to_asset_key,
                price_feed_data = jsonb_merge(price_feed.price_feed_data, u.price_feed_data)
              FROM (VALUES %L) AS u(feed_key, from_asset_key, to_asset_key, price_feed_data)
              WHERE price_feed.feed_key = u.feed_key
              RETURNING
                price_feed.price_feed_id as "priceFeedId",
                price_feed.feed_key as "feedKey",
                price_feed.from_asset_key as "fromAssetKey",
                price_feed.to_asset_key as "toAssetKey",
                price_feed.price_feed_data as "priceFeedData"`,
              [priceFeedsToUpdate.map((obj) => [obj.data.feedKey, obj.data.fromAssetKey, obj.data.toAssetKey, obj.data.priceFeedData])],
              options.ctx.client,
            );

      const results = [...insertResults, ...updateResults];

      const idMap = keyBy(results, "feedKey");
      return new Map(
        objAndData.map(({ data }) => {
          const feed = idMap[data.feedKey];
          if (!feed) {
            throw new ProgrammerError({ msg: "Upserted price feed not found", data });
          }
          return [data, feed];
        }),
      );
    },
  });
}

export function fetchPriceFeed$<TObj, TErr extends ErrorEmitter<TObj>, TRes>(options: {
  ctx: ImportCtx;
  emitError: TErr;
  getPriceFeedId: (obj: TObj) => number | null;
  formatOutput: (obj: TObj, priceFeed: DbPriceFeed | null) => TRes;
}): Rx.OperatorFunction<TObj, TRes> {
  return dbBatchCall$({
    ctx: options.ctx,
    emitError: options.emitError,
    getData: options.getPriceFeedId,
    formatOutput: options.formatOutput,
    logInfos: { msg: "fetch price feed" },
    processBatch: async (objAndData) => {
      const priceFeedIds = objAndData.map((obj) => obj.data).filter((id) => id !== null);
      const results =
        priceFeedIds.length === 0
          ? []
          : await db_query<DbPriceFeed>(
              `SELECT 
                price_feed_id as "priceFeedId", 
                feed_key as "feedKey",
                from_asset_key as "fromAssetKey",
                to_asset_key as "toAssetKey",
                price_feed_data as "priceFeedData"
              FROM price_feed
              WHERE price_feed_id IN (%L)`,
              [priceFeedIds],
              options.ctx.client,
            );

      // return a map where keys are the original parameters object refs
      const idMap = keyBy(results, "priceFeedId");
      return new Map(objAndData.map(({ data }) => [data, data ? idMap[data] ?? null : null]));
    },
  });
}
