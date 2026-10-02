from coord_worker.ids_validation import validate_ifc

RULES = {0: "rule-columns", 1: "rule-doors"}


def by_key(results):
    return {(r.rule_id, r.element_key): r for r in results}


def test_columns_pass_and_fail_with_reason(sample_ifc, sample_ids):
    results = by_key(validate_ifc(sample_ifc["path"], sample_ids, RULES))

    assert results[("rule-columns", sample_ifc["ok"])].status == "pass"
    failed = results[("rule-columns", sample_ifc["bad"])]
    assert failed.status == "fail"
    assert "C25" in failed.message


def test_optional_requirement_passes_when_property_is_absent(sample_ifc, sample_ids):
    # IDS 1.0: "optional" means "if present, must conform" - absence passes
    results = by_key(validate_ifc(sample_ifc["path"], sample_ids, RULES))
    assert results[("rule-doors", sample_ifc["door"])].status == "pass"


def test_elements_outside_the_applicability_get_no_result(sample_ifc, sample_ids):
    results = validate_ifc(sample_ifc["path"], sample_ids, RULES)
    keys = {r.element_key for r in results}
    assert sample_ifc["wall"] not in keys
    assert len(results) == 3


def test_specifications_without_a_rule_are_skipped(sample_ifc, sample_ids):
    results = validate_ifc(sample_ifc["path"], sample_ids, {0: "rule-columns"})
    assert {r.rule_id for r in results} == {"rule-columns"}
