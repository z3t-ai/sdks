from z3t_ai_agent.schema import VersionSchema, pdf_reference, s, typed_value


def test_fields_required_by_default():
    field = s.string()
    assert field._optional is False


def test_optional_removes_from_required():
    shape = {
        "name": s.string(),
        "nickname": s.string().optional(),
    }
    obj = s.object(shape)
    assert obj._def["required"] == ["name"]


def test_object_omits_required_key_when_all_optional():
    obj = s.object({"nickname": s.string().optional()})
    assert "required" not in obj._def


def test_string_display_and_constraints():
    field = s.string(display="textarea", min_length=1, max_length=10, title="Notes")
    assert field._def == {
        "type": "string",
        "title": "Notes",
        "x-z3t-display": "textarea",
        "minLength": 1,
        "maxLength": 10,
    }


def test_number_slider_maps_to_range_display():
    field = s.number(display="slider", min=0, max=1)
    assert field._def["x-z3t-display"] == "range"
    assert field._def["minimum"] == 0
    assert field._def["maximum"] == 1


def test_enum_with_color_map():
    field = s.enum(["ACTIVE", "INACTIVE"], color_map={"ACTIVE": "green", "INACTIVE": "red"})
    assert field._def["enum"] == ["ACTIVE", "INACTIVE"]
    assert field._def["x-z3t-color-map"] == {"ACTIVE": "green", "INACTIVE": "red"}


def test_file_uri_accept_and_max_size():
    field = s.file_uri(accept=["application/pdf"], max_size_mb=10)
    assert field._def["format"] == "z3t-file-uri"
    assert field._def["x-z3t-accept"] == ["application/pdf"]
    assert field._def["x-z3t-max-size-mb"] == 10


def test_array_of_file_output_gets_file_list_layout():
    field = s.array(s.file_output())
    assert field._def["x-z3t-layout"] == {"type": "file-list"}
    assert "x-z3t-display" not in field._def
    assert "format" not in field._def


def test_array_table_layout():
    field = s.array(s.object({"name": s.string()}), layout="table", sortable=True, searchable=True)
    assert field._def["x-z3t-layout"] == {"type": "table", "sortable": True, "searchable": True}
    assert "x-z3t-display" not in field._def
    assert "x-z3t-table-sortable" not in field._def
    assert "x-z3t-table-searchable" not in field._def
    assert "format" not in field._def


def test_array_other_layouts():
    assert s.array(s.image(), layout="gallery")._def["x-z3t-layout"] == {"type": "gallery"}
    assert s.array(s.string(), layout="grid")._def["x-z3t-layout"] == {"type": "grid"}


def test_pdf_reference_field_shape():
    field = s.pdf_reference()
    assert field._def["x-z3t-display"] == "pdf-reference"
    assert field._def["required"] == ["format", "file"]


def test_pdf_reference_runtime_value():
    value = pdf_reference("z3t://files/abc", page=2, hint="Clause 4.1")
    assert value == {"format": "pdf-reference", "file": "z3t://files/abc", "page": 2, "hint": "Clause 4.1"}


def test_typed_value_runtime_constructors():
    assert typed_value.markdown("**hi**") == {"format": "markdown", "value": "**hi**"}
    assert typed_value.number("42") == {"format": "number", "value": "42"}


def test_version_schema_defaults_to_draft():
    schema = VersionSchema(input=s.object({}), output=s.object({}))
    assert schema.status == "draft"


def test_meta_options_full_set():
    field = s.string(title="T", description="D", hint="H", order=2, group="G")
    assert field._def == {
        "type": "string",
        "title": "T",
        "description": "D",
        "x-z3t-hint": "H",
        "x-z3t-order": 2,
        "x-z3t-group": "G",
    }


def test_email_and_url():
    assert s.email()._def == {"type": "string", "format": "email"}
    assert s.url()._def == {"type": "string", "format": "uri"}


def test_date_and_datetime_with_bounds():
    date_field = s.date(min="2020-01-01", max="2030-01-01")
    assert date_field._def["x-z3t-min"] == "2020-01-01"
    assert date_field._def["x-z3t-max"] == "2030-01-01"

    dt_field = s.datetime(min="2020-01-01T00:00:00Z")
    assert dt_field._def["format"] == "date-time"
    assert dt_field._def["x-z3t-min"] == "2020-01-01T00:00:00Z"


def test_integer_with_slider_and_multiple_of():
    field = s.integer(display="slider", min=0, max=100, multiple_of=5)
    assert field._def == {
        "type": "integer",
        "x-z3t-display": "range",
        "minimum": 0,
        "maximum": 100,
        "multipleOf": 5,
    }


def test_boolean_toggle_display():
    field = s.boolean(display="toggle")
    assert field._def == {"type": "boolean", "x-z3t-display": "toggle"}


def test_taxonomy_ref_and_integration_ref():
    tax = s.taxonomy_ref(taxonomy_slug="departments")
    assert tax._def["x-z3t-taxonomy-slug"] == "departments"

    integ = s.integration_ref(provider="salesforce")
    assert integ._def["x-z3t-integration-provider"] == "salesforce"


def test_output_only_field_displays():
    for name, field in [("html", s.html()), ("json", s.json()), ("image", s.image()), ("markdown", s.markdown())]:
        assert field._def["x-z3t-display"] == name, f"{name} should set x-z3t-display"
        assert "format" not in field._def, f"{name} should not set format"
    assert s.code(language="python")._def == {"type": "string", "x-z3t-display": "code", "x-z3t-code-language": "python"}
    assert "format" not in s.code(language="python")._def
    assert s.percent()._def == {"type": "number", "x-z3t-display": "percent"}
    assert "format" not in s.percent()._def
    assert s.file_output()._def == {"type": "string", "x-z3t-display": "file-output"}
    assert "format" not in s.file_output()._def
