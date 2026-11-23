import test from 'node:test';
import assert from 'node:assert/strict';
import {modelUndoSignature} from '../src/history.js';
test('camera orbit, pan and zoom do not create a different modeling undo state',()=>{
  const state={floors:[{count:8}],position:[0,0,0],cameraPosition:[10,10,10],orbitTarget:[0,0,0]};
  const key=s=>modelUndoSignature(JSON.stringify(s));
  assert.equal(key(state),key({...state,cameraPosition:[100,-40,20],orbitTarget:[4,7,2]}));
  assert.notEqual(key(state),key({...state,floors:[{count:9}]}));
  assert.notEqual(key(state),key({...state,position:[0,0,5]}));
});
