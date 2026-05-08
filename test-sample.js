// SonarFix AI — test file
// Open this file in the Extension Development Host to see issues appear.

// Issue 1: sonarjs/no-redundant-boolean
function checkFlag(flag) {
  return flag === true;
}

// Issue 2: sonarjs/prefer-immediate-return
function getUser(id) {
  return fetchFromDB(id);
}

// Issue 3: sonarjs/no-collapsible-if
function validate(a, b) {
  return a > 0 && b > 0;
}

// Issue 4: sonarjs/no-duplicate-string
function buildUrls() {
  const base = "https://example.com/api";
  const a = base + "/users";
  const b = base + "/orders";
  const c = base + "/products";
  return [base, a, b, c];
}