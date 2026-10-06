type JsonRecord = Record<string, unknown>;

const MAX_SCHEMA_BYTES = 256 * 1024;
const FIELD_TYPES = new Set([
  "text",
  "textarea",
  "number",
  "date",
  "time",
  "select",
  "lookup",
  "entity_lookup",
  "checkbox",
  "notice",
  "repeater",
]);
const RULE_OPERATORS = new Set(["eq", "neq", "in", "not_in", "exists"]);
const STATUS_CATEGORIES = new Set([
  "draft",
  "in_review",
  "returned",
  "approved",
  "in_progress",
  "completed",
  "rejected",
  "cancelled",
]);
const WORKFLOW_ROLES = new Set([
  "admin",
  "fleet_team",
  "procurement",
  "finance",
  "approver",
  "department_requester",
]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface FormCutoffPolicy {
  time: string;
  timezone: string;
  latePolicy: "flag" | "flag_and_exception_approval";
  exceptionStage?: string;
}

export function evaluateFormCutoff(
  submittedAt: Date,
  policy: FormCutoffPolicy,
) {
  const [cutoffHour, cutoffMinute] = policy.time.split(":").map(Number);
  const localParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: policy.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(submittedAt);
  const localHour = Number(
    localParts.find((part) => part.type === "hour")?.value,
  );
  const localMinute = Number(
    localParts.find((part) => part.type === "minute")?.value,
  );
  const isLate = localHour * 60 + localMinute > cutoffHour * 60 + cutoffMinute;
  return {
    isLate,
    reason: isLate
      ? `Submitted after ${policy.time} ${policy.timezone}; supervisory exception review required.`
      : null,
  };
}

export function validateFormSchema(
  schema: unknown,
  availableLovCodes: Set<string>,
): string[] {
  const errors: string[] = [];
  if (!isRecord(schema)) return ["Form schema must be an object."];
  const serialized = JSON.stringify(schema);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SCHEMA_BYTES) {
    errors.push("Form definition exceeds the 256 KB size limit.");
  }
  if (!Array.isArray(schema.sections) || schema.sections.length === 0) {
    errors.push("Add at least one section before publishing.");
    return errors;
  }

  const rootFields = schema.sections.flatMap((section) =>
    isRecord(section) && Array.isArray(section.fields) ? section.fields : [],
  );
  const rootKeys = new Set(
    rootFields
      .filter(isRecord)
      .map((field) => field.key)
      .filter((key): key is string => typeof key === "string"),
  );
  const seenRootKeys = new Set<string>();

  const visitFields = (
    fields: unknown[],
    scope: string,
    siblingKeys: Set<string>,
    availableRuleKeys: Set<string>,
  ) => {
    fields.forEach((candidate) => {
      if (!isRecord(candidate)) {
        errors.push("Field definition must be an object.");
        return;
      }

      const key = typeof candidate.key === "string" ? candidate.key.trim() : "";
      const label =
        typeof candidate.label === "string" ? candidate.label.trim() : "";
      if (!key) errors.push(`Field "${label}" is missing a key.`);
      else if (siblingKeys.has(key))
        errors.push(`Field key "${scope}${key}" is duplicated.`);
      else siblingKeys.add(key);
      if (!label) errors.push(`Field "${key}" is missing a label.`);
      if (
        typeof candidate.type !== "string" ||
        !FIELD_TYPES.has(candidate.type)
      ) {
        errors.push(`Field "${label || key}" has an unsupported type.`);
      }

      if (isRecord(candidate.dataSource)) {
        if (
          candidate.dataSource.kind === "lov" &&
          typeof candidate.dataSource.listCode === "string"
        ) {
          if (!availableLovCodes.has(candidate.dataSource.listCode)) {
            errors.push(
              `Field "${label || key}" references unknown LOV list "${candidate.dataSource.listCode}".`,
            );
          }
        } else if (
          !(
            candidate.dataSource.kind === "entity" &&
            candidate.dataSource.entity === "vehicles"
          )
        ) {
          errors.push(`Field "${label || key}" has an invalid data source.`);
        }
      }

      if (Array.isArray(candidate.rules)) {
        candidate.rules.forEach((rule) => {
          if (!isRecord(rule) || !isRecord(rule.when)) {
            errors.push(
              `Field "${label || key}" has an invalid rule condition.`,
            );
            return;
          }
          if (
            typeof rule.when.field !== "string" ||
            !availableRuleKeys.has(rule.when.field)
          ) {
            errors.push(
              `Field "${label || key}" rule references an unknown field.`,
            );
          }
          if (
            typeof rule.when.operator !== "string" ||
            !RULE_OPERATORS.has(rule.when.operator)
          ) {
            errors.push(
              `Field "${label || key}" has an unsupported rule operator.`,
            );
          }
          if (
            rule.show === false &&
            (candidate.required === true || rule.required === true) &&
            !Object.prototype.hasOwnProperty.call(candidate, "defaultValue")
          ) {
            errors.push(
              `Required field "${label || key}" is hidden by a rule and has no default.`,
            );
          }
        });
      }

      if (Array.isArray(candidate.rowFields)) {
        const childKeys = new Set<string>();
        const rowRuleKeys = new Set([
          ...rootKeys,
          ...candidate.rowFields
            .filter(isRecord)
            .map((field) => field.key)
            .filter((value): value is string => typeof value === "string"),
        ]);
        visitFields(
          candidate.rowFields,
          `${scope}${key}.`,
          childKeys,
          rowRuleKeys,
        );
      }
    });
  };

  rootFields.forEach((candidate) => {
    if (!isRecord(candidate)) return;
    const key = typeof candidate.key === "string" ? candidate.key : "";
    if (key && seenRootKeys.has(key)) {
      errors.push(`Field key "${key}" is duplicated.`);
    }
    if (key) seenRootKeys.add(key);
  });
  visitFields(rootFields, "", new Set(), rootKeys);
  return errors;
}

export function validateFormWorkflow(
  workflow: unknown,
  schema: unknown,
): string[] {
  if (!isRecord(workflow) || Object.keys(workflow).length === 0) return [];
  const errors: string[] = [];
  if (!Array.isArray(workflow.stages) || workflow.stages.length === 0)
    return ["Workflow must define at least one stage."];
  if (!Array.isArray(workflow.transitions))
    return ["Workflow transitions must be an array."];

  const stages = workflow.stages.filter(isRecord);
  const stageIds = new Set<string>();
  stages.forEach((stage) => {
    if (typeof stage.id !== "string" || !stage.id.trim())
      errors.push("Workflow stage ID is required.");
    else if (stageIds.has(stage.id))
      errors.push(`Workflow stage ID "${stage.id}" is duplicated.`);
    else stageIds.add(stage.id);
    if (typeof stage.label !== "string" || !stage.label.trim())
      errors.push(`Workflow stage "${String(stage.id ?? "")}" needs a label.`);
    if (
      typeof stage.statusCategory !== "string" ||
      !STATUS_CATEGORIES.has(stage.statusCategory)
    )
      errors.push(
        `Workflow stage "${String(stage.id ?? "")}" has an invalid system status category.`,
      );
  });
  if (
    typeof workflow.initialStage !== "string" ||
    !stageIds.has(workflow.initialStage)
  )
    errors.push("Initial workflow stage must reference an existing stage.");

  const schemaFields =
    isRecord(schema) && Array.isArray(schema.sections)
      ? schema.sections
          .flatMap((section) =>
            isRecord(section) && Array.isArray(section.fields)
              ? section.fields
              : [],
          )
          .filter(isRecord)
      : [];
  const fieldKeys = new Set(
    schemaFields
      .map((field) => field.key)
      .filter((key): key is string => typeof key === "string"),
  );
  const collectNestedKeys = (fields: unknown[], prefix = ""): string[] => {
    const keys: string[] = [];
    fields.filter(isRecord).forEach((field) => {
      const key =
        typeof field.key === "string"
          ? prefix
            ? `${prefix}.${field.key}`
            : field.key
          : "";
      if (!key) return;
      keys.push(key);
      if (Array.isArray(field.rowFields))
        keys.push(...collectNestedKeys(field.rowFields, key));
    });
    return keys;
  };
  collectNestedKeys(schemaFields).forEach((key) => fieldKeys.add(key));
  stages.forEach((stage) => {
    if (!isRecord(stage.fieldPermissions)) return;
    Object.entries(stage.fieldPermissions).forEach(
      ([fieldKey, rolePermissions]) => {
        if (!fieldKeys.has(fieldKey))
          errors.push(
            `Stage "${String(stage.label)}" permissions reference an unknown field.`,
          );
        if (!isRecord(rolePermissions)) {
          errors.push(
            `Stage "${String(stage.label)}" has an invalid field permission map.`,
          );
          return;
        }
        Object.entries(rolePermissions).forEach(([role, permission]) => {
          if (!WORKFLOW_ROLES.has(role))
            errors.push(
              `Stage "${String(stage.label)}" has an unknown field permission role.`,
            );
          if (!new Set(["edit", "read", "hidden"]).has(String(permission)))
            errors.push(
              `Stage "${String(stage.label)}" has an invalid field permission.`,
            );
        });
      },
    );
  });
  workflow.transitions.filter(isRecord).forEach((transition, index) => {
    if (
      typeof transition.from !== "string" ||
      !stageIds.has(transition.from) ||
      typeof transition.to !== "string" ||
      !stageIds.has(transition.to)
    ) {
      errors.push(
        `Workflow transition ${index + 1} references an unknown stage.`,
      );
    }
    const roles = Array.isArray(transition.roles)
      ? transition.roles
      : typeof transition.role === "string"
        ? [transition.role]
        : [];
    if (
      roles.length === 0 ||
      roles.some(
        (role) => typeof role !== "string" || !WORKFLOW_ROLES.has(role),
      )
    )
      errors.push(`Workflow transition ${index + 1} must contain valid roles.`);
    if (Array.isArray(transition.requiredFields))
      transition.requiredFields.forEach((field) => {
        if (typeof field !== "string" || !fieldKeys.has(field))
          errors.push(
            `Workflow transition ${index + 1} references an unknown required field.`,
          );
      });
    const target = stages.find((stage) => stage.id === transition.to);
    if (
      target &&
      ["returned", "rejected", "cancelled"].includes(
        String(target.statusCategory),
      ) &&
      transition.reasonRequired !== true
    ) {
      errors.push(
        `Transitions to ${String(target.label)} must require a reason.`,
      );
    }
  });

  if (workflow.cutoff !== undefined) {
    if (!isRecord(workflow.cutoff))
      errors.push("Cutoff policy must be an object.");
    else {
      if (
        typeof workflow.cutoff.time !== "string" ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(workflow.cutoff.time)
      )
        errors.push("Cutoff time must use 24-hour HH:MM format.");
      if (
        typeof workflow.cutoff.timezone !== "string" ||
        !workflow.cutoff.timezone.trim()
      )
        errors.push("Cutoff timezone is required.");
      else {
        try {
          new Intl.DateTimeFormat("en-US", {
            timeZone: workflow.cutoff.timezone,
          });
        } catch {
          errors.push(
            `Cutoff timezone "${workflow.cutoff.timezone}" is invalid.`,
          );
        }
      }
      if (
        !new Set(["flag", "flag_and_exception_approval"]).has(
          String(workflow.cutoff.latePolicy),
        )
      )
        errors.push("Cutoff late policy is invalid.");
      if (
        workflow.cutoff.latePolicy === "flag_and_exception_approval" &&
        (typeof workflow.cutoff.exceptionStage !== "string" ||
          !stageIds.has(workflow.cutoff.exceptionStage))
      )
        errors.push(
          "Cutoff exception stage must reference an existing workflow stage.",
        );
      if (
        workflow.cutoff.latePolicy === "flag_and_exception_approval" &&
        (typeof workflow.cutoff.exceptionStage !== "string" ||
          !stageIds.has(workflow.cutoff.exceptionStage))
      )
        errors.push(
          "Cutoff exception stage must reference an existing workflow stage.",
        );
    }
  }
  return errors;
}

export interface FormSubmissionValidation {
  errors: string[];
  labelSnapshots: Record<string, { code: string; label: string }>;
}

type LovLabelResolver = (
  listCode: string,
  itemCode: string,
) => Promise<string | null>;
type EntityLabelResolver = (
  entity: string,
  id: string,
) => Promise<string | null>;

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function matchesRule(rule: JsonRecord, values: JsonRecord): boolean {
  if (!isRecord(rule.when)) return false;
  const actual = values[String(rule.when.field)];
  switch (rule.when.operator) {
    case "eq":
      return actual === rule.when.value;
    case "neq":
      return actual !== rule.when.value;
    case "in":
      return Array.isArray(rule.when.value) && rule.when.value.includes(actual);
    case "not_in":
      return (
        Array.isArray(rule.when.value) && !rule.when.value.includes(actual)
      );
    case "exists":
      return isPresent(actual);
    default:
      return false;
  }
}

export async function validateFormSubmission(
  schema: unknown,
  payload: unknown,
  resolveLovLabel: LovLabelResolver,
  resolveEntityLabel: EntityLabelResolver = async () => null,
): Promise<FormSubmissionValidation> {
  const errors: string[] = [];
  const labelSnapshots: FormSubmissionValidation["labelSnapshots"] = {};
  if (!isRecord(schema) || !Array.isArray(schema.sections)) {
    return { errors: ["Published form schema is invalid."], labelSnapshots };
  }
  if (!isRecord(payload)) {
    return { errors: ["Submission data must be an object."], labelSnapshots };
  }

  const rootFields = schema.sections.flatMap((section) =>
    isRecord(section) && Array.isArray(section.fields) ? section.fields : [],
  );
  const validateFields = async (
    fields: unknown[],
    values: JsonRecord,
    pathPrefix: string,
    ruleValues: JsonRecord,
  ): Promise<void> => {
    const fieldKeys = new Set(
      fields
        .filter(isRecord)
        .map((field) => field.key)
        .filter((key): key is string => typeof key === "string"),
    );
    Object.keys(values).forEach((key) => {
      if (!fieldKeys.has(key))
        errors.push(`Unknown field "${pathPrefix}${key}".`);
    });

    for (const candidate of fields) {
      if (!isRecord(candidate) || typeof candidate.key !== "string") continue;
      const key = candidate.key;
      const label = typeof candidate.label === "string" ? candidate.label : key;
      const value = values[key];
      const fieldPath = `${pathPrefix}${key}`;
      if (candidate.type === "notice") {
        if (Object.prototype.hasOwnProperty.call(values, key))
          errors.push(`Display-only field "${fieldPath}" cannot be submitted.`);
        continue;
      }

      let visible = true;
      let required = candidate.required === true;
      if (Array.isArray(candidate.rules)) {
        candidate.rules.filter(isRecord).forEach((rule) => {
          if (!matchesRule(rule, ruleValues)) return;
          if (typeof rule.show === "boolean") visible = rule.show;
          if (typeof rule.required === "boolean") required = rule.required;
        });
      }
      if (!visible) {
        if (isPresent(value))
          errors.push(`Hidden field "${fieldPath}" cannot be submitted.`);
        continue;
      }

      if (candidate.type === "repeater") {
        const rowFields = Array.isArray(candidate.rowFields)
          ? candidate.rowFields
          : [];
        const rows = Array.isArray(value) ? value : [];
        const minRows =
          typeof candidate.minRows === "number"
            ? candidate.minRows
            : required
              ? 1
              : 0;
        if (rows.length < minRows)
          errors.push(
            `${label} requires at least ${minRows} row${minRows === 1 ? "" : "s"}.`,
          );
        if (
          typeof candidate.maxRows === "number" &&
          rows.length > candidate.maxRows
        )
          errors.push(`${label} allows at most ${candidate.maxRows} rows.`);
        if (value !== undefined && !Array.isArray(value))
          errors.push(`Field "${fieldPath}" must be an array.`);
        for (let index = 0; index < rows.length; index++) {
          if (!isRecord(rows[index])) {
            errors.push(`Field "${fieldPath}[${index}]" must be an object.`);
            continue;
          }
          await validateFields(
            rowFields,
            rows[index],
            `${fieldPath}[${index}].`,
            { ...ruleValues, ...rows[index] },
          );
        }
        continue;
      }

      if (required && !isPresent(value)) errors.push(`${label} is required.`);
      if (!isPresent(value)) continue;

      if (
        isRecord(candidate.dataSource) &&
        candidate.dataSource.kind === "lov"
      ) {
        const listCode = String(candidate.dataSource.listCode ?? "");
        const code = String(value);
        const itemLabel = await resolveLovLabel(listCode, code);
        if (!itemLabel)
          errors.push(
            `Field "${fieldPath}" has an invalid or inactive option.`,
          );
        else labelSnapshots[fieldPath] = { code, label: itemLabel };
      } else if (
        isRecord(candidate.dataSource) &&
        candidate.dataSource.kind === "entity"
      ) {
        const entity = String(candidate.dataSource.entity ?? "");
        const id = String(value);
        const entityLabel = await resolveEntityLabel(entity, id);
        if (!entityLabel)
          errors.push(
            `Field "${fieldPath}" has an invalid or unavailable entity.`,
          );
        else labelSnapshots[fieldPath] = { code: id, label: entityLabel };
      } else if (
        (candidate.type === "select" || candidate.type === "lookup") &&
        Array.isArray(candidate.options)
      ) {
        const isValid = candidate.options.some(
          (option) => isRecord(option) && option.value === value,
        );
        if (!isValid)
          errors.push(`Field "${fieldPath}" has an invalid option.`);
      }
    }
  };

  await validateFields(rootFields, payload, "", payload);
  return { errors, labelSnapshots };
}

export function projectReportableFields(
  schema: unknown,
  data: unknown,
): Record<string, unknown> {
  if (!isRecord(schema) || !Array.isArray(schema.sections) || !isRecord(data))
    return {};
  const projectFields = (
    fields: unknown[],
    values: JsonRecord,
  ): Record<string, unknown> => {
    const report: Record<string, unknown> = {};
    fields.filter(isRecord).forEach((field) => {
      if (
        typeof field.key !== "string" ||
        !isRecord(field.meta) ||
        field.meta.pii === true
      )
        return;
      const value = values[field.key];
      if (field.type === "repeater" && Array.isArray(value)) {
        const rowFields = Array.isArray(field.rowFields) ? field.rowFields : [];
        const rows = value
          .filter(isRecord)
          .map((row) => projectFields(rowFields, row));
        if (rows.some((row) => Object.keys(row).length > 0))
          report[field.key] = rows;
      } else if (field.meta.reportable === true && value !== undefined) {
        report[field.key] = value;
      }
    });
    return report;
  };
  const fields = schema.sections.flatMap((section) =>
    isRecord(section) && Array.isArray(section.fields) ? section.fields : [],
  );
  return projectFields(fields, data);
}
