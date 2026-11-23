# QuickRead

A desktop PDF reader for research papers. Click a term to recall what it means without losing your place; ask a local model when you want to go deeper.

![QuickRead showing a term card](docs/screenshot.png)

## Run it

```bash
npm start
```

`npm run dev` runs it with hot reload. To open a specific file: `npm start -- /path/to/paper.pdf`.

To build the standalone app:

```bash
npm run package
```

This writes `dist/mac-arm64/QuickRead.app`, which can be dragged into Applications. It is signed ad hoc for this Mac only. The app icon is `build/icon.icns`.

## Look

The interface is styled after early-2000s desktops: Luna-blue title bars, gel buttons, bevelled fields, an Explorer-style side pane and a messenger-style companion. It is all in `src/renderer/src/styles.css`, with the palette as CSS variables at the top.

## What it does

- **Term lookup.** When a paper is first opened, the local model builds a glossary and underlines those terms in the text. Clicking one shows a short summary, the sentence in the paper that defines it, the pages that mention it, and a button that jumps to the definition. A "Back" pill (or ⌘[) returns to where you were.
- **Any text.** Select a word or phrase and choose **Define** to look up something the glossary missed.
- **Citations.** Clicking a number such as `[38]` shows the bibliography entry and can find the paper online. arXiv papers can be opened directly in QuickRead.
- **Reading companion.** The side panel answers questions from the paper with page links. **Dive deeper** on a term gives a longer explanation plus further reading, drawn from the paper's own references and from Wikipedia, arXiv and OpenAlex.
- **Highlights, notes, bookmarks, contents.** Stored per paper and restored when it is reopened.

## Models

Everything runs locally through Ollama. QuickRead starts its own Ollama server on port 11435 (so it does not clash with another install on 11434) and stops it on quit.

| Role | Default | Change in |
| --- | --- | --- |
| Chat | `inkling-2-mini` | Settings |
| Embeddings | `embeddinggemma-2:270m` | Settings |

Only web searches leave the machine, and they carry just the search query.

## Layout

- `src/main` — window, storage, Ollama client, web search
- `src/renderer/src/lib/controller.ts` — PDF.js viewer wrapper: term and citation marks, highlights, jumps
- `src/renderer/src/lib/extract.ts` — text, sections and bibliography extraction
- `src/renderer/src/lib/brain.ts` — glossary, definitions, retrieval
- `src/renderer/src/App.tsx` — app state and the companion

Per-paper data lives in `~/Library/Application Support/quickread/docs/<id>/`.
