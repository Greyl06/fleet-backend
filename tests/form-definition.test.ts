import { describe, expect, it } from "vitest";
import {
  validateFormSchema,
  validateFormSubmission,
  evaluateFormCutoff,
  validateFormWorkflow,
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

describe("validateFormWorkflow", () => {
  const workflow = {
    initialStage: "submitted",
    stages: [
      { id: "submitted", label: "Submitted", statusCategory: "in_review" },
      { id: "rejected", label: "Rejected", statusCategory: "rejected" },
    ],
    transitions: [
      { from: "submitted", to: "rejected", roles: ["approver"], reasonRequired: true },
    ],
    cutoff: { time: "16:00", timezone: "Asia/Manila", latePolicy: "flag_and_exception_approval", exceptionStage: "submitted" },
  };

  it("accepts configured stages, authorized transitions, and cutoff policy", () => {
    expect(validateFormWorkflow(workflow, validSchema)).toEqual([]);
  });

  it("rejects missing stage roles, reasons, and invalid cutoff settings", () => {
    const invalid = structuredClone(workflow);
    invalid.transitions[0].roles = [];
    invalid.transitions[0].reasonRequired = false;
    invalid.cutoff.time = "29:90";
    invalid.stages[0].fieldPermissions = { missing: { unknown_role: "write" } };
    expect(validateFormWorkflow(invalid, validSchema)).toEqual(expect.arrayContaining([
      "Workflow transition 1 must contain valid roles.",
      "Transitions to Rejected must require a reason.",
      "Cutoff time must use 24-hour HH:MM format.",
      'Stage "Submitted" permissions reference an unknown field.',
      'Stage "Submitted" has an unknown field permission role.',
      'Stage "Submitted" has an invalid field permission.',
    ]));
  });
});

describe("evaluateFormCutoff", () => {
  it("evaluates after-cutoff submissions in the configured timezone", () => {
    const onTime = evaluateFormCutoff(new Date("2026-10-02T07:59:00.000Z"), {
      time: "16:00", timezone: "Asia/Manila", latePolicy: "flag",
    });
    const afterCutoff = evaluateFormCutoff(new Date("2026-10-02T08:01:00.000Z"), {
      time: "16:00", timezone: "Asia/Manila", latePolicy: "flag",
    });
    expect(onTime.isLate).toBe(false);
    expect(afterCutoff.isLate).toBe(true);
    expect(afterCutoff.reason).toContain("Asia/Manila");
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

  it("validates active entity lookups and snapshots the entity label", async () => {
    const schema = structuredClone(validSchema);
    schema.sections[0].fields.push({
      id: "vehicle",
      key: "vehicleId",
      type: "entity_lookup",
      label: "Fleet Vehicle",
      required: true,
      dataSource: { kind: "entity", entity: "vehicles", valueField: "id", labelField: "plateNumber" },
    });
    const result = await validateFormSubmission(
      schema,
      { department: "IT", project: "Request", vehicleId: "vehicle-id" },
      async () => "Information Technology",
      async (entity, id) => entity === "vehicles" && id === "vehicle-id" ? "ABC-1234" : null,
    );
    expect(result.errors).toEqual([]);
    expect(result.labelSnapshots.vehicleId).toEqual({ code: "vehicle-id", label: "ABC-1234" });
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
