"""IDS validation of an IFC file with IfcTester, as rows for coord_check_results.

Pure function of (IFC path, IDS XML, rules): no database or storage access,
so it is unit tested directly against small generated IFC files.
"""

from collections import defaultdict
from dataclasses import dataclass

import ifcopenshell
from ifctester import ids

MAX_MESSAGE_LENGTH = 1000


@dataclass(frozen=True)
class IdsResult:
    rule_id: str
    element_key: str  # IFC GlobalId == Speckle applicationId
    status: str  # "pass" | "fail" (warning severity is applied by the Node worker)
    message: str | None


def validate_ifc(
    ifc_path: str, ids_xml: str, rule_by_spec: dict[int, str]
) -> list[IdsResult]:
    """Runs every IDS specification that has a matching rule and returns one
    result per (rule, element) the specification applies to."""
    specs = ids.from_string(ids_xml)
    model = ifcopenshell.open(ifc_path)
    specs.validate(model)

    results: list[IdsResult] = []
    for index, spec in enumerate(specs.specifications):
        rule_id = rule_by_spec.get(index)
        if not rule_id:
            continue
        # Specification written for another IFC schema: nothing applies
        if getattr(spec, "is_ifc_version", True) is False:
            continue

        reasons: dict[int, list[str]] = defaultdict(list)
        for requirement in spec.requirements:
            for failure in getattr(requirement, "failures", []) or []:
                element = failure.get("element")
                reason = failure.get("reason")
                if element is not None and reason:
                    reasons[element.id()].append(str(reason))

        seen: set[str] = set()
        for status, entities in (
            ("pass", spec.passed_entities),
            ("fail", spec.failed_entities),
        ):
            for entity in entities:
                global_id = getattr(entity, "GlobalId", None)
                # Entities without a GlobalId can't be tied to a Speckle element
                if not global_id or global_id in seen:
                    continue
                seen.add(global_id)
                message = None
                if status == "fail":
                    unique = list(dict.fromkeys(reasons.get(entity.id(), [])))
                    message = ("; ".join(unique) or "Requisito não atendido")[
                        :MAX_MESSAGE_LENGTH
                    ]
                results.append(IdsResult(rule_id, global_id, status, message))
    return results
