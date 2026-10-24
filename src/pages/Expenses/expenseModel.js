export const moneyRound=(value)=>Math.round((value+Number.EPSILON)*100)/100;
export function cashSourceTarget(transaction) {
 const page={sale_payment:"sales",purchase_payment:"purchases",customer_refund:"customers"}[transaction.source_type];
 return page&&transaction.source_document_id?{page,documentId:transaction.source_document_id,paymentId:transaction.source_id}:null;
}
export function cashSummary(transactions,from="",to="") {
 const sum=(rows)=>moneyRound(rows.reduce((value,row)=>value+(row.direction==="IN"?row.amount_afn:-row.amount_afn),0));
 const valid=transactions.filter((row)=>!row.voided_at);
 return {balance:sum(valid),inflow:moneyRound(valid.filter((r)=>r.direction==="IN").reduce((s,r)=>s+r.amount_afn,0)),outflow:moneyRound(valid.filter((r)=>r.direction==="OUT").reduce((s,r)=>s+r.amount_afn,0)),opening:from?sum(valid.filter((r)=>r.date.slice(0,10)<from)):0,closing:sum(valid.filter((r)=>!to||r.date.slice(0,10)<=to))};
}
export function expenseSummary(documents,today,from="",to="") {
 const sum=(rows)=>moneyRound(rows.reduce((s,r)=>s+r.amount_afn,0));
 const active=documents.filter((r)=>!r.deleted_at),expenses=active.filter((r)=>r.kind==="EXPENSE");
 return {todayExpenses:sum(expenses.filter((r)=>r.date===today)),monthExpenses:sum(expenses.filter((r)=>r.date.slice(0,7)===today.slice(0,7)&&r.date<=today)),totalWithdrawals:sum(active.filter((r)=>r.kind==="WITHDRAWAL")),periodExpenses:sum(expenses.filter((r)=>(!from||r.date>=from)&&(!to||r.date<=to)))};
}
