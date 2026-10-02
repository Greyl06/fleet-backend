import { describe, expect, it } from "vitest";
import {
  validateFormSchema,
  validateFormSubmission,
} from "../src/domain/form-definition.js";

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

describe("validateFormSubmission", () => {
  it("validates required fields and snapshots active LOV labels", async () => {
    const result = await validateFormSubmission(
      validSchema,
      { department: "IT", project: "Fleet pickup" },
      async (listCode, code) => listCode === "DEPARTMENTS" && code === "IT" ? "Information Technology" : null,
    );
    expect(result.errors).toEqual([]);
    expect(result.labelSnapshots).toEqual({ department: { code: "IT", label: "Information Technology" } });
  });

  it("rejects unknown fields, missing required values, and invalid LOV options", async () => {
    const result = await validateFormSubmission(
      validSchema,
      { department: "NO_SUCH_DEPARTMENT", unexpected: "tampered" },
      async () => null,
    );
    expect(result.errors).toEqual(expect.arrayContaining([
      'Unknown field "unexpected".',
      "Project is required.",
      'Field "department" has an invalid or inactive option.',
    ]));
  });

  it("rejects submitted values hidden by a matching rule and invalid repeater bounds", async () => {
    const schema = {
      ...validSchema,
      sections: [{
        ...validSchema.sections[0],
        fields: [
          ...validSchema.sections[0].fields,
          {
            id: "confidential", key: "confidential", type: "text", label: "Confidential",
            rules: [{ when: { field: "department", operator: "eq", value: "IT" }, show: false }],
          },
          {
            id: "passengers", key: "passengers", type: "repeater", label: "Passengers", required: true,
            minRows: 1, maxRows: 2,
            rowFields: [{ id: "passenger-name", key: "name", type: "text", label: "Name", required: true }],
          },
        ],
      }],
    };
    const result = await validateFormSubmission(
      schema,
      { department: "IT", project: "Request", confidential: "hidden", passengers: [{}, {}, {}] },
      async () => "Information Technology",
    );
    expect(result.errors).toEqual(expect.arrayContaining([
      'Hidden field "confidential" cannot be submitted.',
      "Passengers allows at most 2 rows.",
      "Name is required.",
    ]));
  });
});
