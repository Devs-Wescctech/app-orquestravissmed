const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const Module=require('node:module');
const path=require('node:path');
const filename=path.resolve(__dirname,'../src/lib/booking-sync-state.ts');
const m=new Module(filename,module); m.paths=module.paths;
m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,filename);
const {bookingSyncState,bookingPendingNotice}=m.exports;
test('existing IDs do not overwrite pending flags',()=>{
 assert.equal(bookingSyncState({doctoraliaBookingId:'123',syncedToDoctoralia:false}).syncedToDoctoralia,false);
});
test('a persisted break can represent a legacy VISSMED association',()=>{
 assert.equal(bookingSyncState({doctoraliaBreakId:'123'}).syncedToDoctoralia,true);
});
test('ownership and refusal pending remain visibly pending',()=>{
 for(const syncError of ['BREAK_OWNERSHIP_PENDING','VISMED_REFUSAL_CANCEL_PENDING','BREAK_CONFLICT']) {
  assert.equal(bookingSyncState({origin:'DOCTORALIA',syncedToDoctoralia:true,syncError}).syncedToDoctoralia,false);
  assert.ok(bookingPendingNotice({syncError}));
 }
});
test('unknown errors do not expose raw patient or server data',()=>{
 const notice=bookingPendingNotice({syncError:'secret patient data'});
 assert.ok(notice);assert.ok(!JSON.stringify(notice).includes('secret patient'));
 assert.equal(bookingPendingNotice({}),null);
});
