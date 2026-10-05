"""Small IFCs with boxes at known positions, for the clash tests.

Dimensions in metres. add_wall_representation builds a box from the
placement origin: length along X, thickness along Y, height along Z.
"""

import ifcopenshell
import ifcopenshell.api
import numpy as np


class BoxModel:
    def __init__(self, name: str):
        self.model = ifcopenshell.file(schema="IFC4")
        api = ifcopenshell.api.run
        api("root.create_entity", self.model, ifc_class="IfcProject", name=name)
        api("unit.assign_unit", self.model)
        model3d = api("context.add_context", self.model, context_type="Model")
        self.body = api(
            "context.add_context",
            self.model,
            context_type="Model",
            context_identifier="Body",
            target_view="MODEL_VIEW",
            parent=model3d,
        )

    def box(self, ifc_class: str, name: str, origin, length, thickness, height):
        api = ifcopenshell.api.run
        el = api("root.create_entity", self.model, ifc_class=ifc_class, name=name)
        rep = api(
            "geometry.add_wall_representation",
            self.model,
            context=self.body,
            length=length,
            height=height,
            thickness=thickness,
        )
        api(
            "geometry.assign_representation", self.model, product=el, representation=rep
        )
        matrix = np.eye(4)
        matrix[:3, 3] = origin
        api("geometry.edit_object_placement", self.model, product=el, matrix=matrix)
        return el

    def write(self, path) -> str:
        self.model.write(str(path))
        return str(path)


def build_clash_models(tmp_path) -> dict:
    """Structure (1 column) and architecture (slab, near/far walls, a hosted
    door and two connected walls)."""
    struct = BoxModel("Estrutura")
    column = struct.box("IfcColumn", "C1", (1.0, 1.0, 0.0), 0.3, 0.3, 3.0)

    arch = BoxModel("Arquitetura")
    slab = arch.box("IfcSlab", "S1", (0.0, 0.0, 1.5), 4.0, 4.0, 0.2)
    far = arch.box("IfcWall", "W-far", (10.0, 10.0, 0.0), 1.0, 0.2, 3.0)
    # column spans x 1.0-1.3: gaps of 30 mm and 80 mm
    near30 = arch.box("IfcWall", "W-30mm", (1.33, 1.0, 0.0), 0.1, 0.3, 3.0)
    near80 = arch.box("IfcWall", "W-80mm", (1.38, 1.0, 0.0), 0.1, 0.3, 3.0)

    # hosted: door filling an opening that voids the host wall
    host = arch.box("IfcWall", "W-host", (20.0, 0.0, 0.0), 4.0, 0.2, 3.0)
    opening = arch.box("IfcOpeningElement", "O1", (21.0, -0.1, 0.0), 1.0, 0.4, 2.1)
    # the door (with frame) is 20 cm wider than the opening, so it overlaps the
    # wall left after the opening is cut - the case "ignore hosted" exists for
    # thinner than the wall and centred in it: no coplanar faces (IfcOpenShell #4594)
    door = arch.box("IfcDoor", "D1", (20.9, 0.05, 0.0), 1.2, 0.1, 2.1)
    api = ifcopenshell.api.run
    api("feature.add_feature", arch.model, feature=opening, element=host)
    api("feature.add_filling", arch.model, opening=opening, element=door)

    # connected: two walls overlapping at a corner
    w1 = arch.box("IfcWall", "W1", (30.0, 0.0, 0.0), 3.0, 0.2, 3.0)
    w2 = arch.box("IfcWall", "W2", (32.9, -1.0, 0.0), 0.2, 2.0, 3.0)
    arch.model.createIfcRelConnectsElements(
        ifcopenshell.guid.new(), None, "W1-W2", None, None, w1, w2
    )

    return {
        "struct": struct.write(tmp_path / "struct.ifc"),
        "arch": arch.write(tmp_path / "arch.ifc"),
        "column": column.GlobalId,
        "slab": slab.GlobalId,
        "far": far.GlobalId,
        "near30": near30.GlobalId,
        "near80": near80.GlobalId,
        "host": host.GlobalId,
        "door": door.GlobalId,
        "w1": w1.GlobalId,
        "w2": w2.GlobalId,
    }
