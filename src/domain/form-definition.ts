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
