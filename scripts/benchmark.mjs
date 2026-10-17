import { performance } from 'node:perf_hooks';
import { extractVisibleQuestions } from '../src/extractor.js';
import { fixtureDom, installLayout } from '../test/dom-helper.js';
import { prepareAnswers, formatAnswers } from '../src/answer-sheet.js';
const dom=fixtureDom('source'),doc=dom.window.document,roots=[...doc.querySelectorAll('.questionLi')];
for(let n=9;n<=20;n++){const clone=roots[(n-9)%roots.length].cloneNode(true);clone.id=`question${500+n}`;clone.querySelector('h3').textContent=`${n}.（合成测试题）`+clone.querySelector('h3').textContent;doc.body.append(clone)}
installLayout(dom.window);
const samples=[];let compact,diagnostic;
for(let i=0;i<7;i++){const start=performance.now();compact=extractVisibleQuestions(doc,{instrument:true});samples.push(performance.now()-start)}
diagnostic=extractVisibleQuestions(doc,{diagnostics:true,instrument:true});
samples.sort((a,b)=>a-b);
const prepareSamples = [], formatSamples = []; let prepared;
for(let i=0;i<7;i++){
  let start=performance.now();prepared=prepareAnswers(compact);prepareSamples.push(performance.now()-start);
  start=performance.now();formatAnswers(compact,prepared.template);formatSamples.push(performance.now()-start);
}
prepareSamples.sort((a,b)=>a-b);formatSamples.sort((a,b)=>a-b);
const captureBytes=Buffer.byteLength(JSON.stringify(compact)),packetBytes=Buffer.byteLength(JSON.stringify(prepared.packet));
console.log(JSON.stringify({environment:'jsdom synthetic geometry; bytes are not tokens; not end-to-end browser, OCR or model latency',questions:compact.count,medianMs:+samples[3].toFixed(2),compactBytes:captureBytes,diagnosticBytes:Buffer.byteLength(JSON.stringify(diagnostic)),solvePacketBytes:packetBytes,payloadReductionPercent:+((1-packetBytes/captureBytes)*100).toFixed(1),prepareMedianMs:+prepareSamples[3].toFixed(2),formatMedianMs:+formatSamples[3].toFixed(2),metrics:compact.metrics||compact.timings},null,2));dom.window.close();
