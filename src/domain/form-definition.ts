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
  "checkbox",
  "notice",
  "repeater",
]);
const RULE_OPERATORS = new Set(["eq", "neq", "in", "not_in", "exists"]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
          candidate.dataSource.kind !== "lov" ||
          typeof candidate.dataSource.listCode !== "string"
        ) {
          errors.push(`Field "${label || key}" has an invalid data source.`);
        } else if (!availableLovCodes.has(candidate.dataSource.listCode)) {
          errors.push(
            `Field "${label || key}" references unknown LOV list "${candidate.dataSource.listCode}".`,
          );
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

export interface FormSubmissionValidation {
  errors: string[];
  labelSnapshots: Record<string, { code: string; label: string }>;
}

type LovLabelResolver = (listCode: string, itemCode: string) => Promise<string | null>;

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function matchesRule(rule: JsonRecord, values: JsonRecord): boolean {
  if (!isRecord(rule.when)) return false;
  const actual = values[String(rule.when.field)];
  switch (rule.when.operator) {
    case "eq": return actual === rule.when.value;
    case "neq": return actual !== rule.when.value;
    case "in": return Array.isArray(rule.when.value) && rule.when.value.includes(actual);
    case "not_in": return Array.isArray(rule.when.value) && !rule.when.value.includes(actual);
    case "exists": return isPresent(actual);
    default: return false;
  }
}

export async function validateFormSubmission(
  schema: unknown,
  payload: unknown,
  resolveLovLabel: LovLabelResolver,
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
    const fieldKeys = new Set(fields.filter(isRecord).map((field) => field.key).filter((key): key is string => typeof key === "string"));
    Object.keys(values).forEach((key) => {
      if (!fieldKeys.has(key)) errors.push(`Unknown field "${pathPrefix}${key}".`);
    });

    for (const candidate of fields) {
      if (!isRecord(candidate) || typeof candidate.key !== "string") continue;
      const key = candidate.key;
      const label = typeof candidate.label === "string" ? candidate.label : key;
      const value = values[key];
      const fieldPath = `${pathPrefix}${key}`;
      if (candidate.type === "notice") {
        if (Object.prototype.hasOwnProperty.call(values, key)) errors.push(`Display-only field "${fieldPath}" cannot be submitted.`);
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
        if (isPresent(value)) errors.push(`Hidden field "${fieldPath}" cannot be submitted.`);
        continue;
      }

      if (candidate.type === "repeater") {
        const rowFields = Array.isArray(candidate.rowFields) ? candidate.rowFields : [];
        const rows = Array.isArray(value) ? value : [];
        const minRows = typeof candidate.minRows === "number" ? candidate.minRows : required ? 1 : 0;
        if (rows.length < minRows) errors.push(`${label} requires at least ${minRows} row${minRows === 1 ? "" : "s"}.`);
        if (typeof candidate.maxRows === "number" && rows.length > candidate.maxRows) errors.push(`${label} allows at most ${candidate.maxRows} rows.`);
        if (value !== undefined && !Array.isArray(value)) errors.push(`Field "${fieldPath}" must be an array.`);
        for (let index = 0; index < rows.length; index++) {
          if (!isRecord(rows[index])) {
            errors.push(`Field "${fieldPath}[${index}]" must be an object.`);
            continue;
          }
          await validateFields(rowFields, rows[index], `${fieldPath}[${index}].`, { ...ruleValues, ...rows[index] });
        }
        continue;
      }

      if (required && !isPresent(value)) errors.push(`${label} is required.`);
      if (!isPresent(value)) continue;

      if (isRecord(candidate.dataSource) && candidate.dataSource.kind === "lov") {
        const listCode = String(candidate.dataSource.listCode ?? "");
        const code = String(value);
        const itemLabel = await resolveLovLabel(listCode, code);
        if (!itemLabel) errors.push(`Field "${fieldPath}" has an invalid or inactive option.`);
        else labelSnapshots[fieldPath] = { code, label: itemLabel };
      } else if ((candidate.type === "select" || candidate.type === "lookup") && Array.isArray(candidate.options)) {
        const isValid = candidate.options.some((option) => isRecord(option) && option.value === value);
        if (!isValid) errors.push(`Field "${fieldPath}" has an invalid option.`);
      }
    }
  };

  await validateFields(rootFields, payload, "", payload);
  return { errors, labelSnapshots };
}
