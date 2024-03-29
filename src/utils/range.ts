import { isDate, isNumber } from "lodash";
import { ProgrammerError } from "./programmer-error";

export type SupportedRangeTypes = number | Date;

export interface Range<T extends SupportedRangeTypes> {
  from: T;
  to: T;
}

interface RangeStrategy<T extends SupportedRangeTypes> {
  nextValue: (value: T) => T;
  previousValue: (value: T) => T;
  compare: (a: T, b: T) => number;
  max: (a: T, b: T) => T;
  min: (a: T, b: T) => T;
  diff: (a: T, b: T) => T;
  add: (a: T, b: number) => T;
  clone: (value: T) => T;
  toNumber: (value: T) => number;
}
const rangeStrategies = {
  number: {
    nextValue: (value: number) => value + 1,
    previousValue: (value: number) => value - 1,
    compare: (a: number, b: number) => a - b,
    max: (a: number, b: number) => Math.max(a, b),
    min: (a: number, b: number) => Math.min(a, b),
    diff: (a: number, b: number) => a - b,
    add: (a: number, b: number) => a + b,
    clone: (value: number) => value,
    toNumber: (value: number) => value,
  } as RangeStrategy<number>,
  date: {
    nextValue: (value: Date) => new Date(value.getTime() + 1),
    previousValue: (value: Date) => new Date(value.getTime() - 1),
    compare: (a: Date, b: Date) => a.getTime() - b.getTime(),
    max: (a: Date, b: Date) => (a.getTime() > b.getTime() ? a : b),
    min: (a: Date, b: Date) => (a.getTime() > b.getTime() ? b : a),
    diff: (a: Date, b: Date) => new Date(a.getTime() - b.getTime()),
    add: (a: Date, b: number) => new Date(a.getTime() + b),
    clone: (value: Date) => new Date(value.getTime()),
    toNumber: (value: Date) => value.getTime(),
  } as RangeStrategy<Date>,
};

function rangeClone<T extends SupportedRangeTypes>(range: Range<T>, strategy?: RangeStrategy<T>): Range<T> {
  const strat = strategy || getRangeStrategy(range);
  return { from: strat.clone(range.from), to: strat.clone(range.to) };
}

function rangeArrayClone<T extends SupportedRangeTypes>(ranges: Range<T>[], strategy?: RangeStrategy<T>): Range<T>[] {
  if (ranges.length <= 0) {
    return [];
  }
  const strat = strategy || getRangeStrategy(ranges[0]);
  return ranges.map((range) => ({ from: strat.clone(range.from), to: strat.clone(range.to) }));
}

// some type guards
export function isDateRange(range: Range<any>): range is Range<Date> {
  return isDate(range.from);
}
export function isNumberRange(range: Range<any>): range is Range<number> {
  return isNumber(range.from);
}

export function isValidRange<T extends SupportedRangeTypes>(range: Range<T>, strategy?: RangeStrategy<T>): boolean {
  const strat = strategy || getRangeStrategy(range);

  return strat.compare(range.from, range.to) <= 0;
}
function checkRange<T extends SupportedRangeTypes>(range: Range<T>, strategy?: RangeStrategy<T>) {
  const strat = strategy || getRangeStrategy(range);
  if (!isValidRange(range, strat)) {
    throw new ProgrammerError({ msg: "Range is invalid: from > to", data: { range } });
  }
}

function getRangeStrategy<T extends SupportedRangeTypes>(range: Range<T>): RangeStrategy<T> {
  if (!range) {
    throw new ProgrammerError("Provided range is not defined: " + range);
  }
  const val = range.from;
  if (isDate(val)) {
    return rangeStrategies.date as any as RangeStrategy<T>;
  } else if (typeof val === "number") {
    return rangeStrategies.number as any as RangeStrategy<T>;
  } else {
    throw new ProgrammerError("Unsupported range type: " + typeof val);
  }
}

export function getRangeSize<T extends SupportedRangeTypes>(range: Range<T>, strategy?: RangeStrategy<T>): number {
  const strat = strategy || getRangeStrategy(range);
  return Math.max(0, strat.toNumber(range.to) - strat.toNumber(range.from) + 1 /* always add 1 since it's a closed-closed range */);
}

export function rangeToNumber<T extends SupportedRangeTypes>(range: Range<T>, strategy?: RangeStrategy<T>): Range<number> {
  const strat = strategy || getRangeStrategy(range);
  return { from: strat.toNumber(range.from), to: strat.toNumber(range.to) };
}

export function isInRange<T extends SupportedRangeTypes>(range: Range<T>, value: T, strategy?: RangeStrategy<T>): boolean {
  const strat = strategy || getRangeStrategy(range);
  return strat.compare(range.from, value) <= 0 && strat.compare(value, range.to) <= 0;
}

/**
 * True if A includes B
 * True if B is included in A
 */
export function rangeInclude<T extends SupportedRangeTypes>(a: Range<T>, b: Range<T>, strategy?: RangeStrategy<T>): boolean {
  const strat = strategy || getRangeStrategy(a);

  if (strat.compare(a.from, b.from) > 0) {
    return false;
  }
  if (strat.compare(b.to, a.to) > 0) {
    return false;
  }
  return true;
}

export function rangeOverlap<T extends SupportedRangeTypes>(a: Range<T>, b: Range<T>, strategy?: RangeStrategy<T>): boolean {
  const strat = strategy || getRangeStrategy(a);
  if (strat.compare(a.from, b.to) > 0) {
    return false;
  }
  if (strat.compare(b.from, a.to) > 0) {
    return false;
  }
  return true;
}

export function rangeArrayOverlap<T extends SupportedRangeTypes>(ranges: Range<T>[], strategy?: RangeStrategy<T>): boolean {
  if (ranges.length <= 1) {
    return false;
  }
  const strat = strategy || getRangeStrategy(ranges[0]);

  // sort to make only one pass
  ranges = rangeSort(ranges, strat);
  for (let i = 1; i < ranges.length; i++) {
    if (rangeOverlap(ranges[i - 1], ranges[i], strat)) {
      return true;
    }
  }
  return false;
}

export function rangeManyOverlap<T extends SupportedRangeTypes>(ranges: Range<T>[], other: Range<T>[], strategy?: RangeStrategy<T>): boolean {
  if (ranges.length <= 0) {
    return false;
  }
  const strat = strategy || getRangeStrategy(ranges[0]);

  // sort to make only one pass
  ranges = rangeSort(ranges, strat);
  other = rangeSort(other, strat);

  let i = 0;
  let j = 0;

  while (i < ranges.length && j < other.length) {
    if (rangeOverlap(ranges[i], other[j])) {
      return true;
    }

    if (strat.compare(ranges[i].to, other[j].from) < 0) {
      i++;
    } else {
      j++;
    }
  }

  return false;
}

export function rangeIntersect<TRange extends SupportedRangeTypes>(
  ranges: Range<TRange>[],
  intersectWith: Range<TRange>,
  strategy?: RangeStrategy<TRange>,
) {
  const strat = strategy || getRangeStrategy(intersectWith);
  const res: Range<TRange>[] = [];
  for (const range of ranges) {
    if (!rangeOverlap(range, intersectWith)) {
      continue;
    }
    res.push({
      from: strat.max(range.from, intersectWith.from),
      to: strat.min(range.to, intersectWith.to),
    });
  }
  return res;
}

export function rangeCovering<TRange extends SupportedRangeTypes>(ranges: Range<TRange>[], strategy?: RangeStrategy<TRange>) {
  const strat = strategy || getRangeStrategy(ranges[0]);
  return { from: ranges.map((r) => r.from).reduce(strat.min, ranges[0].from), to: ranges.map((r) => r.to).reduce(strat.max, ranges[0].to) };
}

export function rangeValueMax<T extends SupportedRangeTypes>(values: T[], strategy?: RangeStrategy<T>): T | undefined {
  if (values.length <= 0) {
    return undefined;
  }
  const strat = strategy || getRangeStrategy({ from: values[0], to: values[0] });

  return values.reduce(strat.max, values[0]);
}

export function rangeArrayExclude<T extends SupportedRangeTypes>(ranges: Range<T>[], exclude: Range<T>[], strategy?: RangeStrategy<T>) {
  const strat = strategy || (ranges.length > 0 ? getRangeStrategy(ranges[0]) : undefined);
  return ranges.flatMap((range) => rangeExcludeMany(range, exclude, strat));
}

/**
 * should be faster than rangeArrayExclude if we can sort the ranges
 */
export function rangeSortedArrayExclude<T extends SupportedRangeTypes>(ranges: Range<T>[], exclude: Range<T>[], strategy?: RangeStrategy<T>) {
  const strat = strategy || (ranges.length > 0 ? getRangeStrategy(ranges[0]) : undefined);
  // sometimes, sorting would be slower than just iterating over the ranges
  // this can happen on small ranges only, for now we just sort
  ranges = rangeMerge(ranges); // rangeMerge already does clone and sort
  exclude = rangeMerge(exclude); // rangeMerge already does clone and sort

  const result: Range<T>[] = [];
  for (const range of ranges) {
    // only exclude ranges that overlap with the current range
    let concernedExclude: Range<T>[] = [];
    for (const ex of exclude) {
      if (rangeOverlap(range, ex, strat)) {
        concernedExclude.push(ex);
      } else {
        // we can break here because the exclude ranges are sorted
        break;
      }
    }
    const exclusionRes = rangeExcludeMany(range, exclude, strat);
    result.push(...exclusionRes);
  }
  return result;
}

export function rangeExcludeMany<T extends SupportedRangeTypes>(range: Range<T>, exclude: Range<T>[], strategy?: RangeStrategy<T>): Range<T>[] {
  const strat = strategy || getRangeStrategy(range);
  checkRange(range, strat);

  let ranges = [range];
  for (const ex of exclude) {
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i];
      const exclusionRes = rangeExclude(range, ex, strat);

      // nothing was excluded so we keep the range
      if (exclusionRes.length === 1 && rangeEqual(exclusionRes[0], range, strat)) {
        continue;
      }
      // the range was fully excluded so we remove it
      else if (exclusionRes.length === 0) {
        ranges.splice(i, 1);
        i--;
        // an exclusion was made so we replace the range with the exclusion result and retry
      } else {
        ranges.splice(i, 1, ...exclusionRes);
        i--;
      }
    }
  }
  return ranges;
}

export function rangeEqual<T extends SupportedRangeTypes>(a: Range<T>, b: Range<T>, strategy?: RangeStrategy<T>) {
  const strat = strategy || getRangeStrategy(a);
  checkRange(a, strat);
  checkRange(b, strat);
  return strat.compare(a.from, b.from) === 0 && strat.compare(a.to, b.to) === 0;
}

export function rangeExclude<T extends SupportedRangeTypes>(range: Range<T>, exclude: Range<T>, strategy?: RangeStrategy<T>): Range<T>[] {
  const strat = strategy || getRangeStrategy(range);
  checkRange(range, strat);
  checkRange(exclude, strat);

  // ranges are exclusives
  if (range.to < exclude.from) {
    return [rangeClone(range)];
  }
  if (range.from > exclude.to) {
    return [rangeClone(range)];
  }

  // exclusion fully contains the range
  if (range.from >= exclude.from && range.to <= exclude.to) {
    return [];
  }

  // exclusion is inside the range
  if (range.from < exclude.from && range.to > exclude.to) {
    return [
      { from: range.from, to: strat.previousValue(exclude.from) },
      { from: strat.nextValue(exclude.to), to: range.to },
    ];
  }

  // exclusion overlaps the range start
  if (range.from >= exclude.from && range.to >= exclude.to) {
    return [{ from: strat.nextValue(exclude.to), to: range.to }];
  }

  // exclusion overlaps the range end
  if (range.from <= exclude.from && range.to <= exclude.to) {
    return [{ from: range.from, to: strat.previousValue(exclude.from) }];
  }

  return [];
}

function rangeSort<T extends SupportedRangeTypes>(ranges: Range<T>[], strategy?: RangeStrategy<T>): Range<T>[] {
  if (ranges.length <= 1) {
    return ranges;
  }
  const strat = strategy || getRangeStrategy(ranges[0]);
  return ranges.sort((a, b) => strat.compare(a.from, b.from));
}

export function rangeMerge<T extends SupportedRangeTypes>(ranges: Range<T>[], strategy?: RangeStrategy<T>): Range<T>[] {
  if (ranges.length <= 1) {
    return rangeArrayClone(ranges);
  }
  const strat = strategy || getRangeStrategy(ranges[0]);
  const sortedRanges = ranges.sort((a, b) => strat.compare(a.from, b.from));
  const mergedRanges: Range<T>[] = [];

  let currentMergedRange: Range<T> | null = null;
  for (const range of sortedRanges) {
    checkRange(range, strat);

    if (!currentMergedRange) {
      currentMergedRange = rangeClone(range);
      continue;
    }

    if (strat.compare(range.from, currentMergedRange.from) === 0) {
      currentMergedRange.to = strat.max(currentMergedRange.to, range.to);
      continue;
    }

    if (range.from <= strat.nextValue(currentMergedRange.to)) {
      currentMergedRange.to = strat.max(currentMergedRange.to, range.to);
      continue;
    }

    if (currentMergedRange) {
      mergedRanges.push(currentMergedRange);
      currentMergedRange = rangeClone(range);
    }
  }

  if (currentMergedRange) {
    mergedRanges.push(currentMergedRange);
  }

  return mergedRanges;
}

export function rangeSlitToMaxLength<T extends SupportedRangeTypes>(range: Range<T>, maxLength: number, strategy?: RangeStrategy<T>): Range<T>[] {
  const strat = strategy || getRangeStrategy(range);
  checkRange(range, strat);

  const ranges: Range<T>[] = [];
  let currentRange: Range<T> = rangeClone(range);

  while (strat.toNumber(strat.nextValue(strat.diff(currentRange.to, currentRange.from))) > maxLength) {
    ranges.push({ from: currentRange.from, to: strat.previousValue(strat.add(currentRange.from, maxLength)) });
    currentRange.from = strat.add(currentRange.from, maxLength);
  }

  ranges.push(currentRange);

  return ranges;
}

export function rangeSplitManyToMaxLength<T extends SupportedRangeTypes>(
  ranges: Range<T>[],
  maxLength: number,
  strategy?: RangeStrategy<T>,
): Range<T>[] {
  const strat = strategy || (ranges.length > 0 ? getRangeStrategy(ranges[0]) : undefined);
  return ranges.flatMap((range) => rangeSlitToMaxLength(range, maxLength, strat));
}

/**
 * In one single operation
 * - sort ranges
 * - make sure they are merged if needed
 * - make sure they are split if needed
 * - only take the first `take` ranges
 *
 * Hopefully it's faster than doing it in multiple steps
 */
export function rangeSortedSplitManyToMaxLengthAndTakeSome<T extends SupportedRangeTypes>(
  ranges: Range<T>[],
  maxLength: number,
  take: number,
  sort: "asc" | "desc" = "asc",
  strategy?: RangeStrategy<T>,
): Range<T>[] {
  if (ranges.length <= 0 || take <= 0 || maxLength <= 0) {
    return [];
  }
  const strat = strategy || getRangeStrategy(ranges[0]);

  ranges = rangeArrayClone(ranges, strat);
  const result: Range<T>[] = [];

  // helper methods
  const isTooBig = (range: Range<T>) => strat.toNumber(strat.nextValue(strat.diff(range.to, range.from))) > maxLength;
  const enough = () => result.length >= take;
  const addToResult = (range: Range<T>) => {
    // some temporary checks until we are sure this is working
    // it's ok to miss some ranges, but we should never have overlapping or invalid ranges
    checkRange(range, strat);
    if (result.length > 0 && rangeOverlap(result[result.length - 1], range, strat)) {
      throw new Error("Range overlap with previous value");
    }
    result.push(range);
  };

  // reverse sort so we can pop the last elements first
  ranges = sort === "asc" ? rangeSort(ranges, strat).reverse() : rangeSort(ranges, strat);

  while (!enough() && ranges.length > 0) {
    const mergedRange = ranges.pop()!;

    // split this range if needed
    if (isTooBig(mergedRange)) {
      // faster version of rangeSlitToMaxLength that only takes the first `take` ranges
      // tricky because we need to keep the ranges sorted
      let currentRange: Range<T> = rangeClone(mergedRange);
      while (!enough() && isTooBig(currentRange)) {
        if (sort === "desc") {
          addToResult({ from: strat.add(currentRange.to, 1 - maxLength), to: currentRange.to });
          currentRange.to = strat.previousValue(strat.add(currentRange.to, 1 - maxLength));
        } else {
          addToResult({ from: currentRange.from, to: strat.previousValue(strat.add(currentRange.from, maxLength)) });
          currentRange.from = strat.add(currentRange.from, maxLength);
        }
      }
      // don't forget to put the rest back in the queue
      ranges.push(currentRange);
      continue;
    }

    // consume ranges until we either have reached maxLength or we can't merge it anymore
    // we don't need the merge function because we know the ranges are sorted by "from"
    let currentRange: Range<T> = rangeClone(mergedRange);
    while (!enough() && !isTooBig(currentRange)) {
      const nextRange = ranges.pop()!;
      // there is no next range, we can stop here
      if (!nextRange) {
        addToResult(currentRange);
        break;
      }

      // current range is too far away, put it back in the queue and stop there
      if (!rangeOverlap(currentRange, nextRange)) {
        addToResult(currentRange);
        ranges.push(nextRange);
        break;
      }

      // current range is now close enough for a merge

      // if we would reach maxLength by merging, only merge the part that we can merge
      // and stop there

      if (sort === "desc") {
        if (isTooBig({ from: nextRange.from, to: currentRange.to })) {
          currentRange.from = strat.add(currentRange.to, 1 - maxLength);
          addToResult(currentRange);
          ranges.push({ from: nextRange.from, to: strat.previousValue(currentRange.from) });
          break;
        } else {
          currentRange.from = strat.min(currentRange.from, nextRange.from);
        }
      } else {
        if (isTooBig({ from: currentRange.from, to: nextRange.to })) {
          currentRange.to = strat.previousValue(strat.add(currentRange.from, maxLength));
          addToResult(currentRange);
          ranges.push({ from: strat.nextValue(currentRange.to), to: nextRange.to });
          break;
        } else {
          currentRange.to = strat.max(currentRange.to, nextRange.to);
        }
      }
    }
  }

  return result;
}
