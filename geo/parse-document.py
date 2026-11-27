import sys, io, json, zipfile, re, subprocess, xml.etree.ElementTree as ET
MAX=2*1024*1024
def xml(z,n):
    b=z.read(n)
    if len(b)>4*1024*1024 or re.search(br'<!DOCTYPE|<!ENTITY',b,re.I): raise ValueError("unsafe xml")
    return ET.fromstring(b)
def local(t): return t.split("}")[-1]
def texts(e,tag): return [n.text or "" for n in e.iter() if local(n.tag)==tag]
def parse(ext,b):
    if ext=="pdf":
        if not b.startswith(b"%PDF-"): raise ValueError("invalid pdf")
        r=subprocess.run(["pdftotext","-f","1","-l","20","-layout","-","-"],input=b,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=10,check=True)
        return r.stdout.decode("utf-8","strict"),"PDF text, first 20 pages at most; no OCR"
    with zipfile.ZipFile(io.BytesIO(b)) as z:
        infos=z.infolist()
        if len(infos)>500 or sum(i.file_size for i in infos)>16*1024*1024 or any(i.file_size>4*1024*1024 or i.flag_bits&1 for i in infos): raise ValueError("archive limit")
        if len({i.filename for i in infos})!=len(infos): raise ValueError("duplicate archive member")
        if ext=="docx":
            return "\n".join("".join(texts(p,"t")) for p in xml(z,"word/document.xml").iter() if local(p.tag)=="p"),"DOCX main document paragraphs"
        if ext=="xlsx":
            shared=[]
            if "xl/sharedStrings.xml" in z.namelist():
                shared=["".join(texts(n,"t")) for n in xml(z,"xl/sharedStrings.xml").iter() if local(n.tag)=="si"]
            lines=[]
            names=sorted(n for n in z.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml",n))
            for n in names[:10]:
                lines.append(n)
                for row in (p for p in xml(z,n).iter() if local(p.tag)=="row"):
                    if len(lines)>=1000: break
                    vals=[]
                    for c in row:
                        if local(c.tag)!="c": continue
                        v=next(iter(texts(c,"v")),""); typ=c.get("t")
                        if typ=="s": v=shared[int(v)] if v.isdigit() and int(v)<len(shared) else ""
                        elif typ=="inlineStr": v="".join(texts(c,"t"))
                        vals.append((c.get("r") or "?")+": "+v)
                    lines.append(" | ".join(vals))
            return "\n".join(lines),"XLSX cached values, up to ten worksheet XML files and 1000 lines; formulas not executed"
    raise ValueError("unsupported")
try:
    b=sys.stdin.buffer.read(MAX+1)
    if len(b)>MAX: raise ValueError("file limit")
    t,n=parse(sys.argv[1],b)
    t=t.replace("\x00","").strip()
    if not t: raise ValueError("no text")
    print(json.dumps({"text":t[:12000],"truncated":len(t)>12000,"method":n},ensure_ascii=True))
except Exception:
    sys.exit(1)
