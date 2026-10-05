"""Clash geometry with IfcOpenShell (no database, no storage: testable alone).

Sized for a 1 vCPU / 4 GB VPS (see the clash plan): geometry only for the
selected elements, one iterator thread, and group B processed in slices so
the triangle tree never holds more than A + one slice.
"""

import resource
from dataclasses import dataclass

import ifcopenshell
import ifcopenshell.geom

CLASH_TYPES = {0: "protrusion", 1: "pierce", 2: "collision", 3: "clearance"}


class ClashLimitError(Exception):
    """A failure whose message is safe and useful to show the user as is."""


@dataclass(frozen=True)
class ClashSettings:
    type: str  # hard | clearance
    tolerance_mm: float
    clearance_mm: float | None


@dataclass(frozen=True)
class RawPair:
    key_a: str
    key_b: str
    distance_mm: float  # hard: negative penetration; clearance: the gap found
    point: tuple[float, float, float]
    clash_type: str
    relation: str | None  # hosted | connected | same_system


def peak_rss_mb() -> int:
    # ru_maxrss is in KiB on Linux
    return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)


def _geom_settings() -> ifcopenshell.geom.settings:
    settings = ifcopenshell.geom.settings()
    # both models in the same world frame (different IFCs, same project origin)
    settings.set("use-world-coords", True)
    return settings


def _elements(model: ifcopenshell.file, keys: list[str]) -> list:
    found = []
    for key in keys:
        try:
            found.append(model.by_guid(key))
        except RuntimeError:
            # selected in Speckle but absent from this IFC (e.g. not a product)
            continue
    return found


def _relations(model: ifcopenshell.file) -> dict[frozenset[str], str]:
    """Pairs related in the IFC: hosted (opening fill), connected, same system."""
    relations: dict[frozenset[str], str] = {}
    hosts: dict[int, str] = {}
    for rel in model.by_type("IfcRelVoidsElement"):
        hosts[rel.RelatedOpeningElement.id()] = rel.RelatingBuildingElement.GlobalId
    for rel in model.by_type("IfcRelFillsElement"):
        host = hosts.get(rel.RelatingOpeningElement.id())
        if host:
            relations[frozenset((host, rel.RelatedBuildingElement.GlobalId))] = "hosted"
    for rel in model.by_type("IfcRelConnectsElements"):
        if rel.RelatingElement and rel.RelatedElement:
            relations.setdefault(
                frozenset((rel.RelatingElement.GlobalId, rel.RelatedElement.GlobalId)),
                "connected",
            )
    for rel in model.by_type("IfcRelAssignsToGroup"):
        if not rel.RelatingGroup or not rel.RelatingGroup.is_a("IfcSystem"):
            continue
        members = [
            o.GlobalId for o in rel.RelatedObjects or [] if hasattr(o, "GlobalId")
        ]
        for i, a in enumerate(members):
            for b in members[i + 1 :]:
                relations.setdefault(frozenset((a, b)), "same_system")
    return relations


def compute_clashes(
    *,
    path_a: str,
    path_b: str,
    keys_a: list[str],
    keys_b: list[str],
    settings: ClashSettings,
    slice_size: int = 1500,
    max_pairs: int = 50_000,
) -> list[RawPair]:
    """Runs the clash between group A (in path_a) and group B (in path_b).
    The same path for both sides opens the file once (A x A or two groups of
    one model)."""
    model_a = ifcopenshell.open(path_a)
    model_b = model_a if path_b == path_a else ifcopenshell.open(path_b)
    group_a = _elements(model_a, keys_a)
    group_b = _elements(model_b, keys_b)
    if not group_a or not group_b:
        raise ClashLimitError(
            "Os elementos selecionados não foram encontrados nos arquivos IFC"
        )

    relations = _relations(model_a)
    if model_b is not model_a:
        relations.update(_relations(model_b))

    geom = _geom_settings()
    a_ids = {e.id() for e in group_a}
    pairs: dict[tuple[str, str], RawPair] = {}

    for start in range(0, len(group_b), slice_size):
        chunk = group_b[start : start + slice_size]
        tree = ifcopenshell.geom.tree(backend="opencascade.trianglebvh")
        tree.add_iterator(ifcopenshell.geom.iterator(geom, model_a, 1, include=group_a))
        if model_b is model_a:
            extra = [e for e in chunk if e.id() not in a_ids]
            if extra:
                tree.add_iterator(
                    ifcopenshell.geom.iterator(geom, model_b, 1, include=extra)
                )
        else:
            tree.add_iterator(
                ifcopenshell.geom.iterator(geom, model_b, 1, include=chunk)
            )

        if settings.type == "clearance":
            results = tree.clash_clearance_many(
                group_a,
                chunk,
                clearance=(settings.clearance_mm or 0) / 1000,
                check_all=False,
            )
        else:
            results = tree.clash_intersection_many(
                group_a,
                chunk,
                tolerance=settings.tolerance_mm / 1000,
                check_all=True,
            )

        for r in results:
            key_a, key_b = r.a.GlobalId, r.b.GlobalId
            if key_a == key_b:
                continue
            distance_mm = round(r.distance * 1000, 2)
            if settings.type != "clearance":
                distance_mm = -abs(distance_mm)
            pair = RawPair(
                key_a=key_a,
                key_b=key_b,
                distance_mm=distance_mm,
                point=(float(r.p1[0]), float(r.p1[1]), float(r.p1[2])),
                clash_type=CLASH_TYPES.get(r.clash_type, str(r.clash_type)),
                relation=relations.get(frozenset((key_a, key_b))),
            )
            # keep the worst penetration / smallest gap per pair across slices
            current = pairs.get((key_a, key_b))
            if current is None or pair.distance_mm < current.distance_mm:
                pairs[(key_a, key_b)] = pair
            if len(pairs) > max_pairs:
                raise ClashLimitError(
                    f"O teste gerou mais de {max_pairs} pares; "
                    "refine os grupos ou aumente a tolerância"
                )
        del tree

    return list(pairs.values())
