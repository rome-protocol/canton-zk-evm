#!/usr/bin/env python3
"""A stand-in for evm.py (FAKE_ROLE=evm) and canton.py (canton) that keeps balances in the file $FAKE_STATE, for demo/tests/live_test.sh: it lets live.sh's legs run with no chain. Not a model of either."""
import json, sys, os
S = os.environ["FAKE_STATE"]
def load():
    return json.load(open(S)) if os.path.exists(S) else {"u":100,"v":0,"cust":0,"wu":0,"sup":0,"rome_u":0,"rome_v":0,"block":10,"tx":{}, "reg":True, "acc":1, "alloc":[], "n":0, "blocks":{}}
st = load()
who = os.environ["FAKE_ROLE"]; a = sys.argv[1:]
if a and a[0] == os.environ.get("FAKE_FAIL"): sys.exit("fake %s: %s failed" % (who, a[0]))   # a command that fails, named by FAKE_FAIL
def out(o): json.dump(st, open(S,"w")); print(json.dumps(o)); sys.exit(0)
def newtx(kind, **kw):
    st["n"]+=1; tx="0x%064x"%st["n"]; st["block"]+=1
    st["tx"][tx]={"block":st["block"],"kind":kind,**kw}; st["blocks"][str(st["block"])]=kind
    return tx
if who=="evm":
    c=a[0]
    if c=="keys": out({"v":"0x"+"1"*40,"u":"0x"+"2"*40})
    if c=="ether": out({"wei":5,"ether":0})
    if c=="chain": out({"chainId":770101})
    if c=="code": out({"size":1,"codeHash":"0x"+"c"*64})
    if c=="block": out({"number":st["block"],"hash":"0xff","gasUsed":1})
    if c=="wrap": st["rome_v"]+=int(a[3]); out({"tx":newtx("wrap")})
    if c=="approve": out({"tx":newtx("approve")})
    if c=="claim": tx=newtx("claim"); st["wu"]+=10; st["sup"]+=10; st["cust"]+=10; st["u"]-=10; out({"tx":tx})
    if c=="pay": tx=newtx("pay"); st["rome_v"]-=int(a[5]); st["rome_u"]+=int(a[5]); st["u"]-=10; st["v"]+=10; out({"tx":tx})
    if c=="withdraw": tx=newtx("withdraw"); k=int(float(a[3])); st["wu"]-=k; st["sup"]-=k; st["cust"]-=k; st["u"]+=k; out({"tx":tx})
    if c=="give":   # U sends V WtROME; FAKE_DRIFT=give makes it send one less than asked, so that a balance does not come back
        k=int(a[4])-(1 if os.environ.get("FAKE_DRIFT")=="give" else 0); tx=newtx("give"); st["rome_u"]-=k; st["rome_v"]+=k; out({"tx":tx})
    if c=="wait":
        t=st["tx"][a[1]]; out({"block":t["block"],"blockHash":"0xb%d"%t["block"],"gasUsed":1,"status":1,"contract":None,"finalized":True})
    if c=="legs":
        k=st["blocks"][a[1]]; ok=k in("claim","pay","withdraw"); out({"block":int(a[1]),"legs":1 if ok else 0,"kinds":[k] if ok else []})
    if c=="wrapped": out({"balance":"%d.0"%st["wu"],"supply":"%d.0"%st["sup"]})
    if c=="balance": out({"tka": st["rome_u"] if a[2]==("0x"+"2"*40) else st["rome_v"]})
else:
    c=a[0]
    if c=="registered": out({"registered":True})
    if c=="accepted": out({"accepted":st["acc"]>=1})
    if c=="balances": out({"tkb":{"u":[st["u"]],"v":[st["v"]]},"custody":[st["cust"]],"allocations":[],"terms":0,"deposits":0,"acceptances":1})
    if c=="deposit": out({"depositId":"d"*64,"request":"r"*40,"allocation":"a"*40})
    if c=="dvp": out({"id":"e"*64,"terms":"t"*40,"allocation":"a"*40})
    if c=="payment-id": out({"label":a[1],"id":"e"*64})
    if c=="block" and len(a)!=3: sys.exit("canton block must name the party whose holding was made with the record")
    if c=="block": n=a[1]; out({"chain":[{"headNumber":st["block"],"headHash":"x"}],"record":{"number":int(n),"blockHash":"b%s"%n,"proofHex":"ab","proofSha256":"sha"}})
    if c=="return-tkb": k=int(a[2]); st["v"]-=k; st["u"]+=k; out({"label":a[1],"amount":a[2],"offer":None})   # V sends U the TKB
    if c=="settled": out({"record":{"updateId":"upd","offset":7},"holding":{"updateId":"upd","offset":7}})
    out({})
