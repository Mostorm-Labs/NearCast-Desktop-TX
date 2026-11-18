import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,copyFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const [axtpRoot,runtimeRoot,axentCommit]=process.argv.slice(2);
if(!axtpRoot||!runtimeRoot||!axentCommit)throw new Error('Usage: node scripts/sync-axtp-typed-input.mjs <AXTP repo> <Runtime repo> <Axent commit>');
if(!/^[a-f0-9]{40}$/.test(axentCommit))throw new Error('Use a full Axent commit');
const runtimeCommit=execFileSync('git',['-C',resolve(runtimeRoot),'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const read=(repo,commit,path)=>execFileSync('git',['-C',resolve(repo),'show',`${commit}:${path}`]);
const binding=JSON.parse(read(runtimeRoot,runtimeCommit,'AXTP_SPEC.local.json'));
const sourceCommit=binding.baselineCommit;
const corpus=read(axtpRoot,sourceCommit,'contract/test-vectors/input_stream.json');
const protocolBytes=read(axtpRoot,sourceCommit,'contract/generated/protocol.json');
const protocol=JSON.parse(protocolBytes),wire=JSON.parse(corpus).wire;
const ids=read(runtimeRoot,runtimeCommit,'include/core/protocol/generated/axtp_ids_generated.h').toString('utf8');
const tlv=read(runtimeRoot,runtimeCommit,'include/core/protocol/wire/framed_binary/control_tlv_codec.hpp').toString('utf8');
const enumValues=name=>Object.fromEntries([...ids.match(new RegExp(`enum class ${name}[^]*?\\{([^]*?)\\};`))[1].matchAll(/(\w+)\s*=\s*(0x[\dA-Fa-f]+)/g)].map(([,key,value])=>[key,Number(value)]));
const metadata={sourceCommit,runtimeCommit,axentCommit,version:binding.version,
  fingerprint:binding.snapshotSha256,published:binding.published,
  corpusSha256:createHash('sha256').update(corpus).digest('hex'),protocolSha256:createHash('sha256').update(protocolBytes).digest('hex')};
const event=protocol.events.find(event=>event.name==='stream.stateChanged');
const mask=new Uint8Array(2+Math.ceil((event.bitOffset+1)/8));mask[0]=event.eventId>>>8;mask[1]=mask.length-2;mask[2+Math.floor(event.bitOffset/8)]=1<<(event.bitOffset%8);
const session={payloadTypes:Object.fromEntries(protocol.payloadTypes.map(value=>[value.name,value.id])),control:enumValues('ControlOpcode'),rpc:enumValues('RpcOp'),rpcEncodings:enumValues('RpcEncoding'),
  tlv:Object.fromEntries([...tlv.matchAll(/static constexpr std::uint8_t k(\w+) = (0x[\dA-Fa-f]+);/g)].map(([,key,value])=>[key,Number(value)])),
  errorCodes:Object.fromEntries(protocol.errors.map(value=>[value.name,value.code])),registeredMethods:protocol.methods.map(value=>value.name),
  streamStateEvent:{name:event.name,domainId:event.eventId>>>8,bitOffset:event.bitOffset,eventMasks:Buffer.from(mask).toString('hex')}};
mkdirSync('tests/fixtures/axtp',{recursive:true});
writeFileSync('tests/fixtures/axtp/input_stream.json',corpus);
writeFileSync('src/touchback/axtp-input-contract.mjs',`// Generated from exact AXTP/Runtime commits by scripts/sync-axtp-typed-input.mjs.\nexport const INPUT_CONTRACT = Object.freeze(${JSON.stringify(metadata,null,2)});\nexport const INPUT_WIRE = ${JSON.stringify(wire,null,2)};\n`);
writeFileSync('src/touchback/axtp-session-contract.mjs',`// Generated from exact AXTP/Runtime commits by scripts/sync-axtp-typed-input.mjs.\nexport const SESSION_CONTRACT = ${JSON.stringify(session,null,2)};\n`);
for(const name of ['axtp-input-contract.mjs','axtp-session-contract.mjs'])copyFileSync('src/touchback/'+name,'dist/touchback/'+name);
const productPath='tests/fixtures/typed-input-webcast.json';
const product=JSON.parse(readFileSync(productPath,'utf8'));
const refresh=value=>{if(value&&typeof value==='object')for(const [key,child]of Object.entries(value))if(key==='contractFingerprint')value[key]=metadata.fingerprint;else refresh(child);};
refresh(product);writeFileSync(productPath,JSON.stringify(product,null,2)+'\n');
console.log(`Bound ${metadata.version}; ${session.registeredMethods.length} registered methods; corpus ${metadata.corpusSha256}`);
