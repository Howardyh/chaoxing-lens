import { performance } from 'node:perf_hooks';
import { extractVisibleQuestions } from '../src/extractor.js';
import { fixtureDom, installLayout } from '../test/dom-helper.js';
const dom=fixtureDom('source'),doc=dom.window.document,roots=[...doc.querySelectorAll('.questionLi')];
for(let n=9;n<=20;n++){const clone=roots[(n-9)%roots.length].cloneNode(true);clone.id=`question${500+n}`;clone.querySelector('h3').textContent=`${n}.（合成测试题）`+clone.querySelector('h3').textContent;doc.body.append(clone)}
installLayout(dom.window);
const samples=[];let compact,diagnostic;
for(let i=0;i<7;i++){const start=performance.now();compact=extractVisibleQuestions(doc,{instrument:true});samples.push(performance.now()-start)}
diagnostic=extractVisibleQuestions(doc,{diagnostics:true,instrument:true});
samples.sort((a,b)=>a-b);
console.log(JSON.stringify({environment:'jsdom synthetic geometry; not browser/recognition latency',questions:compact.count,medianMs:+samples[3].toFixed(2),compactBytes:Buffer.byteLength(JSON.stringify(compact)),diagnosticBytes:Buffer.byteLength(JSON.stringify(diagnostic)),metrics:compact.metrics||compact.timings},null,2));dom.window.close();
