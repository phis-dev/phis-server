import { PhiBaseRole } from "@/lib/constants/phi-base-roles";

export const PHI_BASE_ROLE_OPTIONS = [
  { label: "Admin", value: "admin", flag: PhiBaseRole.Admin },
  { label: "Maintainer", value: "maintainer", flag: PhiBaseRole.Maintainer },
  { label: "Builder", value: "builder", flag: PhiBaseRole.Builder },
  { label: "Author", value: "author", flag: PhiBaseRole.Author },
  { label: "Publisher", value: "publisher", flag: PhiBaseRole.Publisher },
  { label: "Supporter", value: "supporter", flag: PhiBaseRole.Supporter },
  { label: "Accountant", value: "accountant", flag: PhiBaseRole.Accountant },
] as const;
