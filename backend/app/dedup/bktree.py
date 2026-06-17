"""Index structures for perceptual-hash duplicate detection.

A large library makes the naive all-pairs comparison (O(n^2)) infeasible. A
**BK-tree** keyed on Hamming distance lets us query "everything within distance d
of this hash" while only touching the small slice of the tree that can possibly
match — turning the image pass into roughly O(n · log n) candidate lookups.

Hashes are the 64-bit perceptual hashes produced by ``imagehash.phash`` and
stored as 16-char hex strings. They are parsed to ``int`` once; Hamming distance
is then a population count of the XOR.

``DSU`` (union-find) collapses the discovered "is a near-duplicate of" pairs into
connected components — the duplicate groups the UI shows.
"""
from __future__ import annotations


def hamming(a: int, b: int) -> int:
    """Population count of the XOR — the Hamming distance of two 64-bit hashes."""
    return (a ^ b).bit_count()


def parse_hash(hex_hash: str) -> int | None:
    """Parse a hex pHash to int, or return None if it is malformed/empty."""
    if not hex_hash:
        return None
    try:
        return int(hex_hash, 16)
    except ValueError:
        return None


class _Node:
    __slots__ = ("key", "payloads", "children")

    def __init__(self, key: int, payload):
        self.key = key
        self.payloads = [payload]          # several files can share an identical hash
        self.children: dict[int, _Node] = {}  # edge label = distance to child


class BKTree:
    """Burkhard-Keller tree over Hamming distance for 64-bit hashes."""

    def __init__(self):
        self._root: _Node | None = None

    def add(self, key: int, payload) -> None:
        if self._root is None:
            self._root = _Node(key, payload)
            return
        node = self._root
        while True:
            d = hamming(key, node.key)
            if d == 0:
                node.payloads.append(payload)
                return
            child = node.children.get(d)
            if child is None:
                node.children[d] = _Node(key, payload)
                return
            node = child

    def query(self, key: int, max_dist: int) -> list:
        """Return the payloads of every stored hash within ``max_dist`` of ``key``."""
        if self._root is None:
            return []
        found: list = []
        stack = [self._root]
        while stack:
            node = stack.pop()
            d = hamming(key, node.key)
            if d <= max_dist:
                found.extend(node.payloads)
            # The triangle inequality bounds which child edges can still match:
            # only distances in [d - max_dist, d + max_dist] are reachable.
            lo, hi = d - max_dist, d + max_dist
            for edge, child in node.children.items():
                if lo <= edge <= hi:
                    stack.append(child)
        return found


class DSU:
    """Disjoint-set union (union-find) with path compression by rank."""

    def __init__(self):
        self._parent: dict[int, int] = {}
        self._rank: dict[int, int] = {}

    def _make(self, x: int) -> None:
        if x not in self._parent:
            self._parent[x] = x
            self._rank[x] = 0

    def find(self, x: int) -> int:
        self._make(x)
        root = x
        while self._parent[root] != root:
            root = self._parent[root]
        while self._parent[x] != root:  # path compression
            self._parent[x], x = root, self._parent[x]
        return root

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self._rank[ra] < self._rank[rb]:
            ra, rb = rb, ra
        self._parent[rb] = ra
        if self._rank[ra] == self._rank[rb]:
            self._rank[ra] += 1

    def groups(self, min_size: int = 2) -> list[list[int]]:
        """Return the connected components with at least ``min_size`` members."""
        buckets: dict[int, list[int]] = {}
        for x in self._parent:
            buckets.setdefault(self.find(x), []).append(x)
        return [sorted(members) for members in buckets.values() if len(members) >= min_size]
