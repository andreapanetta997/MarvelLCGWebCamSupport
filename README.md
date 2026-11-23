# Marvel LCG WebCam Support

Una telecamera fissa sopra il tavolo guarda la partita a **Marvel Champions** e
riconosce le carte in gioco. Obiettivo finale: segnalare le azioni previste dal
regolamento che non sono ancora state fatte (fase del cattivo, carte da preparare, ecc.).

## Stato

| Tappa | Stato |
|---|---|
| 1. Tavolo raddrizzato con 4 marker ArUco | ✅ |
| 2. Riconoscimento carte (database MarvelCDB) | ✅ |
| 3. Carte esaurite (ruotate di 90°) | ✅ |
| 4. Tracciato delle fasi con segnalino | ⏳ |
| 5. Checklist delle regole per ogni fase | ⏳ |
| 6. Conteggio segnalini (danni, minaccia) | ⏳ |
| 7. Promemoria degli effetti delle carte | ⏳ |

Test sintetico (`test_synthetic.py`, 140 carte del Core Set in prospettiva, luce irregolare, JPEG):

| Telecamera | Trovate | Riconosciute | Rotazione corretta |
|---|---|---|---|
| 4K (3840×2160) | 139/140 | 139/140 | 100% |
| Full HD (1920×1080) | 132/140 | 132/140 | 100% |

## Versione web (PC e cellulare)

La cartella `docs/` è una pagina web che fa tutto nel browser (OpenCV.js): nessun server,
nessuna installazione. Da PC usa la webcam, dal cellulare la fotocamera posteriore.

**Pubblicarla con GitHub Pages** (una volta sola): sul repository → *Settings* → *Pages* →
*Source: Deploy from a branch* → branch `main`, cartella `/docs` → *Save*.
Dopo un minuto la pagina è su `https://<utente>.github.io/MarvelLCGWebCamSupport/`.
Il cellulare dà accesso alla fotocamera solo su HTTPS, ed è per questo che serve GitHub Pages.
(Pages su un repository privato richiede GitHub Pro.)

**Provarla in locale dal PC**: `python -m http.server 8000 --directory docs` e apri
`http://localhost:8000`. Con `?test=percorso/foto.jpg` analizza subito una foto.

**Aggiungere pack**: `python build_web_index.py core cap_a …` (codici pack di MarvelCDB)
rigenera `docs/data/`; poi scegli i pack nelle *Impostazioni* della pagina.

Sul cellulare: mettilo su un supporto sopra il tavolo, lascia la pagina aperta (lo schermo
resta acceso da solo). Le impostazioni restano salvate nel browser.

Test sintetico nel browser: stessi risultati della versione Python (139/140), circa 0,6 s per analisi su PC.

## Installazione (versione Python)

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

> Se il percorso della cartella è molto lungo Windows può rifiutare l'installazione
> (limite di 260 caratteri): crea il venv in un percorso corto, es. `C:\venvs\mcarbiter`.

## Preparare il tavolo

1. `python make_markers.py` → stampa `markers_A4.png` **al 100%**, ritaglia i 4 marker.
2. Mettili agli angoli dell'area di gioco: 0 alto-sinistra, 1 alto-destra, 2 basso-destra,
   3 basso-sinistra ("basso" = lato dei giocatori).
3. Misura la distanza tra i **centri** dei marker e scrivila in `config.json` (`table_mm`).
4. In `config.json` → `packs` elenca i codici dei pack che usi (es. `"core"`), oppure `"all"`.
   Meno carte = riconoscimento più veloce e più sicuro. Il primo avvio scarica le immagini.

Consigli: tovaglia a tinta unita, luce diffusa (niente lampadina puntata sulle bustine),
qualche millimetro di spazio tra le carte.

## Uso

```powershell
python app.py                  # webcam dal vivo
python app.py --image foto.jpg # una foto con i 4 marker visibili
python test_synthetic.py       # prova senza telecamera
```

Tasti: `Q` esci · `C` ricalibra i marker · `SPAZIO` rianalizza · `S` salva istantanea.
L'analisi parte da sola quando il tavolo resta fermo per mezzo secondo.

## File

- `table.py` – marker ArUco e immagine raddrizzata del tavolo
- `cards.py` – ricerca dei rettangoli delle carte, riconoscimento e rotazione
- `carddb.py` – download dati/immagini da MarvelCDB e indice di riconoscimento
- `app.py` – finestra dal vivo
- `make_markers.py`, `test_synthetic.py` – strumenti (`--save docs/test` salva le foto di prova per la pagina web)
- `build_web_index.py` – prepara l'indice carte per la pagina web
- `docs/` – la pagina web: `vision.js` (stessa logica di `table.py` + `cards.py`), `app.js` (telecamera e interfaccia)

## Limiti noti

- Carte sovrapposte (es. potenziamenti infilati sotto l'eroe) non vengono viste.
- Si presume che i giocatori siano tutti sul lato "basso" del tavolo (per capire se una carta è esaurita).
- Insta360 X4: l'obiettivo fisheye deforma il tavolo; meglio una webcam normale (vedi issue/note).
