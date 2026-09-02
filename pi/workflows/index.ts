import { spBuild } from "./sp-build.js";
import { spFix } from "./sp-fix.js";
import { spReview } from "./sp-review.js";

export const SP_WORKFLOWS = [spBuild, spFix, spReview] as const;
