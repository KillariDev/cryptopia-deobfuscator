import { analyzeFactored, FactoredLimit } from './factored.js'
import { LookupFunction } from './lookup-function.js'
import { RainbowPortfolio } from './rainbow-portfolio.js'
import { LimitedMap } from './limitedMap.js'
import { config } from './config.js'
import { Gate } from './types.js'

/** Restored workspace is discarded only after exact structural identity checks.
 * Remaining live values are opaque inputs, regardless of their primary support. */
export async function opaqueRainbow(gates: Gate[], tables: RainbowPortfolio, cache: LimitedMap<string,Gate[]|null>, stopped:()=>boolean) {
 try {
  const {graph,rows}=analyzeFactored(gates,{maximumWires:config.validation.maximumWires,maximumNodes:config.synthesis.factoredMaximumNodes,maximumEdges:config.synthesis.factoredMaximumEdges,stopped})
  let support=0n
  rows.forEach((row,i)=>{if(row!==graph.inputs[i])support|=row.support|(1n<<BigInt(i))})
  const live=graph.wires.flatMap((wire,i)=>support&(1n<<BigInt(i))?[{wire,index:i}]:[])
  if(!live.length || live.length>Math.min(8,tables.maximumWires))return undefined
  const outputs:boolean[][]=[]
  for(let input=0;input<2**live.length;input++){
   graph.check()
   const atoms=[true,...graph.wires.map((_,i)=>{const bit=live.findIndex(x=>x.index===i);return bit>=0&&!!(input&(1<<bit))})]
   const value=(form:typeof rows[number])=>form.atoms.reduce((bit,atom)=>bit!==atoms[atom],false)
   for(const node of graph.products){graph.check();atoms.push(value(node.left)&&value(node.right))}
   outputs.push(live.map(x=>value(rows[x.index])))
  }
  const hit=(await tables.findReplacements([{mappedGates:gates,wires:live.length,fn:LookupFunction.fromOutputs(outputs,live.length)}],cache)).get(0)
  if(stopped() || !hit || hit.gates.length>=gates.length)return undefined
  return hit.gates.map(g=>({...g,a:live[g.a]?.wire ?? live[0].wire,b:live[g.b]?.wire ?? live[0].wire,target:live[g.target].wire}))
 }catch(error){if(error instanceof FactoredLimit)return undefined;throw error}
}
