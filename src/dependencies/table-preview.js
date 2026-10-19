// Header-aware context without changing the compact row indexes used by stored
// source anchors. Physical worksheet coordinates are presentation metadata.
export function columnLetter(index) {
 let label='';
 for(let n=index;n>=0;n=Math.floor(n/26)-1)label=String.fromCharCode(65+n%26)+label;
 return label;
}
const text=value=>String(value??'').trim();
const numeric=value=>text(value)!=='' && /^[-+($€£¥]?\s*\d[\d,.\s%/():-]*$/.test(text(value));
export function tableContext(table, anchor={}, radius=2, fallbackHeader=-1) {
 const rows=table.rows??[], numbers=table.rowNumbers??rows.map((_,i)=>i+1);
 let target=Number.isInteger(anchor.rowIndex)?(anchor.rowCoordinate==='worksheet'?numbers.indexOf(anchor.rowIndex):anchor.rowIndex):rows.findIndex(r=>r.some(c=>text(c)===text(anchor.rowKey)));
 if(target<0||target>=rows.length)return null;
 const physical=numbers[target], targetColumn=Number.isInteger(anchor.columnIndex)?anchor.columnIndex:null;
 const region=table.tables?.find(t=>physical>=t.firstRow&&physical<=t.lastRow&&(targetColumn==null||targetColumn>=t.firstColumn&&targetColumn<=t.lastColumn));
 const width=Math.max(0,...rows.slice(Math.max(0,target-radius),target+radius+1).map(r=>r.length),region?region.lastColumn+1:0);
 if(!width)return null;
 const value=(row,column)=>{
  const merged=table.merges?.find(m=>numbers[row]>=m.firstRow&&numbers[row]<=m.lastRow&&column>=m.firstColumn&&column<=m.lastColumn);
  if(merged){const start=numbers.indexOf(merged.firstRow);return text(rows[start]?.[merged.firstColumn]);}
  return text(rows[row]?.[column]);
 };
 let header=-1, headerRows=[];
 if(region){
  header=numbers.findIndex(n=>n===region.firstRow);
  if(region.headerRowCount>0 && header>=0)headerRows=[header];
 }else{
  // Prefer headings in the current section, but financial statements often
  // keep one header above many sections separated by blank rows.
  let first=target;
  while(first>0 && numbers[first]-numbers[first-1]<=1 && rows[first-1].some(c=>text(c)))first--;
  const candidates=[];
  for(let i=0;i<target;i++){
   const present=rows[i].map(text).filter(Boolean);
   const words=present.filter(c=>!numeric(c));
   const datesOnly=present.every(c=>/^\d[\d\s/.,:-]*(?:to|–|—)[\d\s/.,:-]+$/i.test(c));
   const next=rows[i+1]??[];
   const dataBelow=next.some(numeric);
   const years=present.filter(c=>/^(19|20)\d{2}$/.test(c)).length>=2;
   const known=present.some(c=>/^(account|name|description|date|item|sample|subject|participant|metric|variable|units?|amount)$/i.test(c));
   if(!datesOnly && present.length>=2 && words.length && (words.length===present.length || known || years)){
    candidates.push({i,dataBelow,score:(i>=first?100:0)+(known?8:0)+(dataBelow?5:0)+Math.min(present.length,6)});
   }
  }
  candidates.sort((a,b)=>b.score-a.score||(a.dataBelow ? b.i-a.i : a.i-b.i));
  header=candidates[0]?.i ?? (fallbackHeader>=0 && fallbackHeader<target && rows[fallbackHeader]?.filter(c=>text(c)&&!numeric(c)).length>=2?fallbackHeader:-1);
  if(header>=0){
   headerRows=[header];
   for(let i=header-1;i>=Math.max(0,header-5);i--){
    const merges=table.merges?.filter(m=>m.firstRow===numbers[i])??[];
    const group=merges.some(m=>m.lastColumn>m.firstColumn && !(m.firstColumn===0&&m.lastColumn>=width-1));
    const nonempty=rows[i].map(text).filter(Boolean);
    if(!group || !nonempty.length)break;
    headerRows.unshift(i);
   }
  }
 }
 const headers=Array.from({length:width},(_,column)=>{
  if(region && column>=region.firstColumn&&column<=region.lastColumn && region.headers?.[column-region.firstColumn])return region.headers?.[column-region.firstColumn];
  return [...new Set(headerRows.map(row=>value(row,column)).filter(Boolean))].join(' · ');
 });
 const headerEnd=headerRows.length?Math.max(...headerRows):region?-1:header;
 let start=Math.max(0,target-radius,headerEnd+1), end=Math.min(rows.length,target+radius+1);
 if(region){while(start<target&&numbers[start]<region.firstRow+region.headerRowCount)start++;while(end>target+1&&numbers[end-1]>region.lastRow)end--;}
 if(start>target)start=target;
 const selected=targetColumn??(anchor.column!=null?headers.indexOf(String(anchor.column)):-1);
 const keep=Array.from({length:width},(_,i)=>i).filter(c=>(!region||c>=region.firstColumn&&c<=region.lastColumn)&&(headers[c]||c===selected||rows.slice(start,end).some(r=>text(r[c]))));
 return {
  columns:keep.map(columnLetter),
  headers:keep.map(c=>headers[c]),
  rows:rows.slice(start,end).map((row,i)=>({rowNumber:numbers[start+i],cells:keep.map(c=>({value:text(row[c]),cited:start+i===target&&(selected<0||c===selected)}))})),
 };
}
