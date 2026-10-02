"""Small IFC fixtures generated with IfcOpenShell itself, with known results."""

from pathlib import Path

import ifcopenshell
import ifcopenshell.api
import pytest

HERE = Path(__file__).parent


@pytest.fixture
def sample_ids() -> str:
    return (HERE / "sample.ids").read_text(encoding="utf-8")


@pytest.fixture
def sample_ifc(tmp_path) -> dict:
    """2 columns (C30 passes, C25 fails), 1 door, 1 wall the IDS ignores."""
    model = ifcopenshell.file(schema="IFC4")
    ifcopenshell.api.run(
        "root.create_entity", model, ifc_class="IfcProject", name="Teste"
    )
    ifcopenshell.api.run("unit.assign_unit", model)

    def element(
        ifc_class: str, name: str, pset: str | None = None, props: dict | None = None
    ):
        el = ifcopenshell.api.run(
            "root.create_entity", model, ifc_class=ifc_class, name=name
        )
        if pset:
            p = ifcopenshell.api.run("pset.add_pset", model, product=el, name=pset)
            ifcopenshell.api.run(
                "pset.edit_pset", model, pset=p, properties=props or {}
            )
        return el

    ok = element("IfcColumn", "P1", "Pset_PHD", {"ClasseConcreto": "C30"})
    bad = element("IfcColumn", "P2", "Pset_PHD", {"ClasseConcreto": "C25"})
    door = element("IfcDoor", "D1")
    wall = element("IfcWall", "W1")
    path = tmp_path / "sample.ifc"
    model.write(str(path))
    return {
        "path": str(path),
        "ok": ok.GlobalId,
        "bad": bad.GlobalId,
        "door": door.GlobalId,
        "wall": wall.GlobalId,
    }
