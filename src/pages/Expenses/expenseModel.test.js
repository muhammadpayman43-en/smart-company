import test from "node:test";
import assert from "node:assert/strict";
import {cashSourceTarget,cashSummary,expenseSummary} from "./expenseModel.js";

test("cash balances include actual movements once and date opening/closing use saved AFN amounts",()=>{
 const ledger=[{direction:"IN",amount:10,currency:"USD",amount_afn:700,date:"2026-09-30"},{direction:"IN",amount_afn:5000,date:"2026-10-20"},{direction:"OUT",amount_afn:500,date:"2026-10-20"},{direction:"OUT",amount_afn:1000,date:"2026-10-20"},{direction:"OUT",amount_afn:999,date:"2026-10-20",voided_at:"2026-10-21"}];
 assert.deepEqual(cashSummary(ledger,"2026-10-01","2026-10-20"),{balance:4200,inflow:5700,outflow:1500,opening:700,closing:4200});
 assert.equal(cashSummary(ledger,"","2026-10-01").closing,700);
 assert.equal(cashSummary([]).balance,0);
});
test("expenses include all payment sources and never count withdrawals or deposits",()=>{
 const documents=[{kind:"EXPENSE",amount_afn:500,date:"2026-10-20",payment_source:"cash"},{kind:"EXPENSE",amount_afn:200,date:"2026-10-19",payment_source:"other"},{kind:"WITHDRAWAL",amount_afn:1000,date:"2026-10-20"},{kind:"DEPOSIT",amount_afn:9000,date:"2026-10-20"},{kind:"EXPENSE",amount_afn:90,date:"2026-10-20",deleted_at:"2026-10-20"}];
 assert.deepEqual(expenseSummary(documents,"2026-10-20","2026-10-20","2026-10-20"),{todayExpenses:500,monthExpenses:700,totalWithdrawals:1000,periodExpenses:500});
});

test("linked cash actions use the original document ID, never the payment ID",()=>{
 for(const [type,page] of [["sale_payment","sales"],["purchase_payment","purchases"],["customer_refund","customers"]]) {
  assert.deepEqual(cashSourceTarget({source_type:type,source_id:"payment",source_document_id:"original"}),{page,documentId:"original",paymentId:"payment"});
  assert.equal(cashSourceTarget({source_type:type,source_id:"payment",source_document_id:null}),null);
 }
 for(const type of ["cash_document","unknown"])assert.equal(cashSourceTarget({source_type:type,source_id:"id",source_document_id:"wrong"}),null);
});
