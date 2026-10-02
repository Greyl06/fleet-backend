import { describe, expect, it } from "vitest";
import { validateFormSchema } from "../src/domain/form-definition.js";

const validSchema = {
  key: "tsrf",
  name: "Transportation Service Request Form",
  sections: [
    {
      id: "request",
      title: "Request",
      fields: [
        {
          id: "department",
          key: "department",
          type: "lookup",
          label: "Department",
          dataSource: { kind: "lov", listCode: "DEPARTMENTS" },
        },
        {
          id: "project",
          key: "project",
          type: "text",
          label: "Project",
          required: true,
        },
      ],
    },
  ],
};

describe("validateFormSchema", () => {
  it("accepts structurally valid schemas with existing LOV sources", () => {
    expect(validateFormSchema(validSchema, new Set(["DEPARTMENTS"]))).toEqual(
      [],
    );
  });

  it("rejects duplicate keys, unknown rule fields, and unknown LOV sources", () => {
    const invalid = structuredClone(validSchema);
    invalid.sections[0].fields[1].key = "department";
    invalid.sections[0].fields[1].rules = [
      { when: { field: "missing", operator: "exists" } },
    ];
    invalid.sections[0].fields[0].dataSource.listCode = "MISSING";

    expect(validateFormSchema(invalid, new Set(["DEPARTMENTS"]))).toEqual(
      expect.arrayContaining([
        'Field key "department" is duplicated.',
        'Field "Project" rule references an unknown field.',
        'Field "Department" references unknown LOV list "MISSING".',
      ]),
    );
  });

  it("rejects required fields hidden by rules without a default", () => {
    const invalid = structuredClone(validSchema);
    invalid.sections[0].fields[1].rules = [
      {
        when: { field: "department", operator: "exists" },
        show: false,
      },
    ];
    expect(validateFormSchema(invalid, new Set(["DEPARTMENTS"]))).toContain(
      'Required field "Project" is hidden by a rule and has no default.',
    );
  });
});
