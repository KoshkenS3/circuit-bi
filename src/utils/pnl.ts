import Decimal from "decimal.js";
import { BIG_ZERO } from "./decimal";

interface PnlTransaction {
  shares: Decimal;
  price: Decimal;
}

type PnLState = {
  sharesFifo: {
    boughtShares: Decimal;
    remainingShares: Decimal;
    entryPrice: Decimal;
  }[];
  realizedPnl: Decimal;
};

// this one is a FIFO pnl calculator:
// https://money.stackexchange.com/a/144091
export class PnL {
  private state: PnLState;

  constructor() {
    this.state = {
      sharesFifo: [],
      realizedPnl: BIG_ZERO,
    };
  }

  addTransaction(transaction: PnlTransaction) {
    if (transaction.shares.isZero()) {
      return;
    }

    if (transaction.shares.isPositive()) {
      this.state.sharesFifo.push({
        boughtShares: transaction.shares,
        remainingShares: transaction.shares,
        entryPrice: transaction.price,
      });
      return;
    }

    let remainingSharesToSell = transaction.shares.negated();
    let trxPnl = BIG_ZERO;
    let idx = 0;
    for (; idx < this.state.sharesFifo.length; idx++) {
      const { remainingShares, entryPrice } = this.state.sharesFifo[idx];
      if (remainingShares.isZero()) {
        continue;
      }

      const sharesToSell = Decimal.min(remainingSharesToSell, remainingShares);
      const priceDiff = transaction.price.minus(entryPrice);
      trxPnl = trxPnl.plus(sharesToSell.times(priceDiff));
      remainingSharesToSell = remainingSharesToSell.minus(sharesToSell);
      this.state.sharesFifo[idx].remainingShares =
        remainingShares.minus(sharesToSell);

      if (remainingSharesToSell.isZero()) {
        break;
      }
    }

    this.state.realizedPnl = this.state.realizedPnl.plus(trxPnl);
    return;
  }

  getUnrealizedPnl(currentPrice: Decimal): Decimal {
    let unrealizedPnl = BIG_ZERO;
    for (const { remainingShares, entryPrice } of this.state.sharesFifo) {
      if (remainingShares.isZero()) {
        continue;
      }

      const priceDiff = currentPrice.minus(entryPrice);
      unrealizedPnl = unrealizedPnl.plus(remainingShares.times(priceDiff));
    }
    return unrealizedPnl;
  }

  getRealizedPnl(): Decimal {
    return this.state.realizedPnl;
  }

  getRemainingShares(): Decimal {
    let remainingShares = BIG_ZERO;
    for (const trx of this.state.sharesFifo) {
      remainingShares = remainingShares.plus(trx.remainingShares);
    }
    return remainingShares;
  }

  getRemainingSharesAvgEntryPrice(): Decimal {
    let totalShares = BIG_ZERO;
    let totalCost = BIG_ZERO;
    for (const { remainingShares, entryPrice } of this.state.sharesFifo) {
      totalShares = totalShares.plus(remainingShares);
      totalCost = totalCost.plus(remainingShares.times(entryPrice));
    }
    if (totalShares.isZero()) {
      return BIG_ZERO;
    }
    return totalCost.div(totalShares);
  }
}