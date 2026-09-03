import json
from pathlib import Path

from graphify.cache import check_semantic_cache


root = Path(".").resolve()
spec = Path(r"C:\Users\User\.codex\skills\graphify\references\extraction-spec.md")
detect = json.loads(Path("graphify-out/.graphify_detect.json").read_text(encoding="utf-8"))
all_files = [
    filename
    for category in ("document", "paper", "image")
    for filename in detect["files"].get(category, [])
]
cached_nodes, cached_edges, cached_hyperedges, uncached = check_semantic_cache(
    all_files,
    root=root,
    prompt_file=spec,
)
cached_path = Path("graphify-out/.graphify_cached.json")
if cached_nodes or cached_edges or cached_hyperedges:
    cached_path.write_text(
        json.dumps(
            {
                "nodes": cached_nodes,
                "edges": cached_edges,
                "hyperedges": cached_hyperedges,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
else:
    cached_path.unlink(missing_ok=True)
Path("graphify-out/.graphify_uncached.txt").write_text("\n".join(uncached), encoding="utf-8")
print(f"Cache: {len(all_files) - len(uncached)} files hit, {len(uncached)} files need extraction")
