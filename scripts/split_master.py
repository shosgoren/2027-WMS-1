# scripts/split_master.py — master dosyayı parça dosyalara böler
import re, sys, pathlib
src = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
START = "<!-" + "- FILE: "          # işaretçi literal olarak bu betikte geçmesin diye parçalı
END = "<!-" + "- END FILE -" + "->"
pat = re.compile(re.escape(START) + r"(.+?) -" + r"->\n(.*?)" + re.escape(END), re.S)
force = "--force" in sys.argv
for path, body in pat.findall(src):
    p = pathlib.Path(path.strip())
    if p.exists() and not force:
        print("SKIP (var):", p); continue
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body.strip() + "\n", encoding="utf-8")
    print("OK:", p)
