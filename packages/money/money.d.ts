/* Types for the ONE bill calculation. money.js is CommonJS because Node
 * requires it and the browsers bundle it; this file is how TypeScript sees the
 * same thing. Every figure is integer LAARI (MVR × 100), in and out. */

export interface BillInput {
  lines: { unitPrice: number; qty: number }[];
  /** Bill-level discount, INCLUSIVE of tax — what the guest is told comes off. */
  discount?: number;
  servicePct?: number;
  taxRate?: number;
  /** A delivery fee, inclusive like a menu price. */
  fee?: number;
  /** Cash rounding increment in laari; 0 for anything but a cash bill. */
  roundTo?: number;
}

export interface Bill {
  /** Goods NET of tax — what `sale.gross` stores. */
  gross: number;
  /** The discount NET of tax, so the invariant closes. */
  discount: number;
  service: number;
  tax: number;
  rounding: number;
  /** What the guest actually pays. */
  total: number;
  netLines: number[];
  taxRate: number;
  taxGoods: number;
  taxService: number;
  taxFee: number;
  feeNet: number;
}

/** A sale's own figures, in laari, as a credit note apportions them. */
export interface SaleFigures {
  gross: number; discount: number; service: number; tax: number;
}
export interface CreditShare {
  goods: number; discount: number; service: number; tax: number;
  /** Net of the discount share — what the credit note row stores. */
  goodsAfterDiscount: number;
  /** What is actually handed back. */
  total: number;
}

export function priceBill(input: BillInput): Bill;
/** What a credit note gives back: a share of the SALE's own figures. */
export function creditShare(goodsNet: number, sale: SaleFigures): CreditShare;
export function taxWithin(inclusive: number, rate: number): number;
export function lineIncl(unitPrice: number, qty: number): number;
export function saleAddsUp(s: Record<string, unknown>): boolean;
