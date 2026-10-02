/**
 * Reference: docs/FLEET_DOMAIN_RULES.md - Rule 5 (TSRF Cutoff Time Flagging)
 * TSRF requests submitted after the department's cutoff time must be flagged,
 * not silently accepted.
 */

export interface TsrfCutoffConfig {
  cutoffHour: number; // 24-hour format, default 16 (4:00 PM)
  cutoffMinute: number;
}

export const DEFAULT_TSRF_CUTOFF: TsrfCutoffConfig = {
  cutoffHour: 16,
  cutoffMinute: 0,
};

export interface TsrfSubmissionEvaluation {
  isFlaggedAfterCutoff: boolean;
  submissionTime: Date;
  cutoffTime: string;
  reason?: string;
}

export function evaluateTsrfSubmissionTime(
  submissionDate: Date,
  config: TsrfCutoffConfig = DEFAULT_TSRF_CUTOFF,
): TsrfSubmissionEvaluation {
  const hours = submissionDate.getHours();
  const minutes = submissionDate.getMinutes();

  const isAfterCutoff =
    hours > config.cutoffHour || (hours === config.cutoffHour && minutes > config.cutoffMinute);

  const formattedCutoff = `${String(config.cutoffHour).padStart(2, '0')}:${String(
    config.cutoffMinute,
  ).padStart(2, '0')}`;

  return {
    isFlaggedAfterCutoff: isAfterCutoff,
    submissionTime: submissionDate,
    cutoffTime: formattedCutoff,
    reason: isAfterCutoff
      ? `Request submitted at ${submissionDate.toLocaleTimeString()} which is after the daily cut-off time (${formattedCutoff}). Flagged for supervisory exception review.`
      : undefined,
  };
}
