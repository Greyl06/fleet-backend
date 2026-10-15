import { Router } from "express";
import { formsAccessRouter } from "./forms-access.routes.js";
import { formsDefinitionRouter } from "./forms-definition.routes.js";
import { formsSubmissionRouter } from "./forms-submission.routes.js";

export {
  canReadAllSubmissions,
  currentSubmissionResponsibility,
  loadReadPolicies,
  projectVisibleSubmissionData,
} from "./forms-common.js";

export const formsRouter = Router();

// Sub-router composition preserving exact path precedence
formsRouter.use(formsAccessRouter);
formsRouter.use(formsSubmissionRouter);
formsRouter.use(formsDefinitionRouter);
