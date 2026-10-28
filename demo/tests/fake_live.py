#!/usr/bin/env python3
"""A stand-in for evm.py (FAKE_ROLE=evm) and canton.py (canton) that keeps balances in the file $FAKE_STATE, for demo/tests/live_test.sh: it lets live.sh's legs run with no chain. Not a model of either."""
import json, sys, os
S = os.environ["FAKE_STATE"]
def load():
    return json.load(open(S)) if os.path.exists(S) else {"u":100,"v":0,"cust":0,"wu":0,"sup":0,"rome_u":0,"rome_v":0,"block":10,"tx":{}, "reg":True, "acc":1, "alloc":[], "n":0, "blocks":{}}
st = load()
who = os.environ["FAKE_ROLE"]; a = sys.argv[1:]
open(S + ".calls", "a").write("%s %s\n" % (who, " ".join(a)))   # every command, for the tests that look at what was (not) called
sfx = "_OTC" if who == "otc" else ""   # the otc commands are failed and slowed by FAKE_FAIL_OTC and FAKE_SLOW_OTC: pay and claim are also commands of the evm
if a and a[0] == os.environ.get("FAKE_FAIL" + sfx): sys.exit("fake %s: %s failed" % (who, a[0]))   # a command that fails, named by FAKE_FAIL
if a and a[0] == os.environ.get("FAKE_SLOW" + sfx): import time; time.sleep(3)   # a command that takes a while, named by FAKE_SLOW
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
    if c=="withdraw":   # u or v burns wTKB, and the TKB go to the party; FAKE_DRIFT=swap-withdraw: v's withdrawal gives one less
        tx=newtx("withdraw"); k=int(float(a[3])); g=k-(1 if os.environ.get("FAKE_DRIFT")=="swap-withdraw" and a[1]=="v" else 0)
        if a[1]=="v": st["wv"]=st.get("wv", 0) - k
        else: st["wu"]-=k
        st["sup"]-=k; st["cust"]-=k; st["u"]+=g; out({"tx":tx})
    if c=="give":   # U sends V WtROME; FAKE_DRIFT=give makes it send one less than asked, so that a balance does not come back
        k=int(a[4])-(1 if os.environ.get("FAKE_DRIFT")=="give" or (os.environ.get("FAKE_DRIFT")=="swap-give" and st.get("swapped")) else 0); tx=newtx("give"); st["rome_u"]-=k; st["rome_v"]+=k; out({"tx":tx})
    if c=="wait":
        t=st["tx"][a[1]]; out({"block":t["block"],"blockHash":"0xb%d"%t["block"],"gasUsed":1,"status":1,"contract":None,"finalized":True})
    if c=="legs":
        k=st["blocks"][a[1]]; ok=k in("claim","pay","withdraw")
        if os.environ.get("FAKE_KIND_FROM") and int(a[1]) >= int(os.environ["FAKE_KIND_FROM"]): k="wrong"   # FAKE_KIND_FROM=<block>: from there on the block's leg is of another kind
        out({"block":int(a[1]),"legs":1 if ok else 0,"kinds":[k] if ok else []})
    if c=="wrapped": out({"balance":"%d.0"%(st["wu"] if a[2]=="0x"+"2"*40 else st.get("wv",0)),"supply":"%d.0"%st["sup"]})
    if c=="used":   # FAKE_USED=yes: the gateway has taken the claim id; FAKE_USED=none: the check gives no answer
        u=os.environ.get("FAKE_USED"); out({} if u=="none" else {"used":u=="yes"})
    if c=="balance": out({"tka": st["rome_u"] if a[2]==("0x"+"2"*40) else st["rome_v"]})
elif who=="otc":   # demo/otc.py: the swap of the cycle (1 TKB for 1 WtROME)
    c=a[0]; sw=st.get("swap")
    if c=="ids": out({"label":a[1],"payId":"p"*64,"claimId":"c"*64})
    if c=="offer": st["swap"]={"label":a[1]}; out({"label":a[1],"offer":"o1"})
    if c=="accept": out({"label":a[1],"trade":"t1"})
    if c=="allocate": st["u"]-=1; st["sa"]=1; out({"label":a[1],"allocation":"a1"})
    if c=="publish": out({"label":a[1],"wrappedToken":a[2] if len(a)>2 else None})
    if c=="pay":   # settles in one block: the TKB are the gateway's, the WtROME the seller's, the funded claim is there
        tx=newtx("pay"); st["sa"]=0; st["cust"]+=1; st["rome_v"]-=1; st["rome_u"]+=1; st["funded"]=True
        out({"label":a[1],"tka":1,"tradeTka":1,"approve":"0xaa","pay":tx,"receipt":{"block":st["block"],"blockHash":"0xb%d"%st["block"],"gasUsed":1,"status":1,"contract":None,"finalized":True}})
    if c=="claim":
        if not st.get("funded"): sys.exit("fake otc: the trade is not settled")
        tx=newtx("claim"); st["funded"]=False; st["wv"]=st.get("wv",0)+1; st["sup"]+=1; st["swapped"]=True
        out({"label":a[1],"claimId":"c"*64,"amount":"1","claim":tx,"receipt":{"block":st["block"],"blockHash":"0xb%d"%st["block"],"gasUsed":1,"status":1,"contract":None,"finalized":True}})
    if c=="check":
        if not sw: sys.exit("fake otc: no trade %s" % a[1])
        out({"label":a[1],"fundedClaim":bool(st.get("funded")),"venueTrade":False,"allocation":bool(st.get("sa"))})
    if c=="close":
        if os.environ.get("FAKE_NO_CLOSE")!="yes": st["swap"]=None
        out({"label":a[1],"closed":["trade"]})
else:
    c=a[0]
    if c=="registered": out({"registered":True})
    if c=="accepted": out({"accepted":st["acc"]>=1})
    if c=="balances": out({"tkb":{"u":[st["u"]],"v":[st["v"]]},"custody":[st["cust"]],"allocations":["swap"] if st.get("sa") else [],"terms":0,"deposits":0,"acceptances":1})
    if c=="deposit": out({"depositId":"d"*64,"request":"r"*40,"allocation":"a"*40})
    if c=="dvp": out({"id":"e"*64,"terms":"t"*40,"allocation":"a"*40})
    if c=="payment-id": out({"label":a[1],"id":"e"*64})
    if c=="block" and len(a)!=3: sys.exit("canton block must name the party whose holding was made with the record")
    if c=="block": n=a[1]; out({"chain":[{"headNumber":st["block"],"headHash":"x"}],"record":{"number":int(n),"blockHash":"b%s"%n,"proofHex":"ab","proofSha256":"sha"}})
    if c=="return-tkb": k=int(a[2]); k-=(1 if os.environ.get("FAKE_DRIFT")=="return-tkb" else 0); st["v"]-=k; st["u"]+=k; out({"label":a[1],"amount":a[2],"offer":None})   # V sends U the TKB
    if c=="settled":   # FAKE_UPD_FROM=<block>: from that block on, the holding comes from another update than the BlockRecord
        other = os.environ.get("FAKE_UPD_FROM") and int(a[1]) >= int(os.environ["FAKE_UPD_FROM"])
        out({"record":{"updateId":"upd","offset":7},"holding":{"updateId":"other" if other else "upd","offset":7}})
    out({})
