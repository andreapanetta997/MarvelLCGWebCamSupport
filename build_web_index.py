"""Prepara l'indice delle carte per la pagina web (cartella docs/data/).

    python build_web_index.py core          solo il Core Set
    python build_web_index.py core cap_a    più pack
    python build_web_index.py all           tutti (scarica migliaia di immagini: lungo!)

Per ogni pack scrive <pack>.bin (descrittori int8, uno per lato di carta) e <pack>.json (nomi),
e aggiorna packs.json con l'elenco dei pack disponibili nella pagina.
"""
import json
import sys
from collections import defaultdict

import numpy as np

import carddb

OUT = carddb.Path(__file__).parent / "docs" / "data"


def main():
    packs = sys.argv[1:] or ["core"]
    index = carddb.build_index("all" if packs == ["all"] else packs)
    names = {c["pack_code"]: c["pack_name"] for c in carddb.load_cards()}

    rows = defaultdict(list)
    for i, m in enumerate(index.meta):
        rows[m["pack"]].append(i)

    OUT.mkdir(parents=True, exist_ok=True)
    listing_path = OUT / "packs.json"
    listing = json.loads(listing_path.read_text(encoding="utf-8")) if listing_path.exists() else {}

    for pack, idx in rows.items():
        d = index.descs[idx]
        # int8 con una scala per riga: 4 volte più leggero di float32, errore trascurabile
        scale = np.abs(d).max(axis=1) / 127
        q = np.round(d / scale[:, None]).astype(np.int8)
        (OUT / f"{pack}.bin").write_bytes(q.tobytes())
        meta = [{"id": index.meta[i]["id"], "name": index.meta[i]["name"], "type": index.meta[i]["type_code"],
                 "ref_rot": index.meta[i]["ref_rot"], "scale": float(s)} for i, s in zip(idx, scale)]
        (OUT / f"{pack}.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        listing[pack] = {"name": names.get(pack, pack), "faces": len(idx)}
        print(f"  {pack}: {len(idx)} lati")

    listing_path.write_text(json.dumps(dict(sorted(listing.items())), ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Fatto: docs/data/ ({len(listing)} pack disponibili)")


if __name__ == "__main__":
    main()
