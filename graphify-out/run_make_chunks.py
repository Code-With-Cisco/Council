import json
from collections import defaultdict
from pathlib import Path


files = [
    line
    for line in Path("graphify-out/.graphify_uncached.txt").read_text(encoding="utf-8").splitlines()
    if line
]
groups: dict[str, list[str]] = defaultdict(list)
for filename in files:
    groups[str(Path(filename).parent)].append(filename)

ordered: list[str] = []
for parent in sorted(groups):
    ordered.extend(sorted(groups[parent]))

chunks = [ordered[index : index + 22] for index in range(0, len(ordered), 22)]
Path("graphify-out/.graphify_chunks.json").write_text(
    json.dumps(chunks, indent=2, ensure_ascii=False),
    encoding="utf-8",
)
print(f"{len(files)} files split into {len(chunks)} chunks: {[len(chunk) for chunk in chunks]}")
