package privacy

import (
	"regexp"
	"strings"
)

// Precompiled high-entropy secrets and credential regexes for Tier 2 scanning.
var (
	// AWS Access Keys
	RegexAWSAccessKey = regexp.MustCompile(`\b(A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b`)
	// GitHub Personal Access Tokens
	RegexGitHubToken = regexp.MustCompile(`\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}\b`)
	// Google API Keys
	RegexGoogleAPIKey = regexp.MustCompile(`\bAIza[0-9A-Za-z\-_]{35}\b`)
	// Stripe Secret / Restricted Keys
	RegexStripeKey = regexp.MustCompile(`\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{24,99}\b`)
	// Private Keys (RSA, EC, DSA, OPENSSH)
	RegexPrivateKey = regexp.MustCompile(`-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----`)
	// JSON Web Tokens (Bearer)
	RegexJWTToken = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`)
	// Credit Card Numbers (Visa, MasterCard, Amex, Discover)
	RegexCreditCard = regexp.MustCompile(`\b(?:\d{4}[ -]?){3}\d{4}\b|\b\d{4}[ -]?\d{6}[ -]?\d{5}\b`)

	// Sensitive Window Title Keywords (Banking, Passwords, Incognito)
	RegexPasswordVault = regexp.MustCompile(`(?i)\b(password|vault|bitwarden|1password|keepass|lastpass|authy|dashlane|roboform|authenticator|keychain)\b`)
	RegexBanking       = regexp.MustCompile(`(?i)\b(bank|banking|chase|wellsfargo|bankofamerica|citibank|fidelity|schwab|paypal|stripe|revolut|coinbase|binance|kraken|robinhood|monzo)\b`)
	RegexIncognito     = regexp.MustCompile(`(?i)\b(incognito|inprivate|private browsing|tor browser|duckduckgo privacy browser)\b`)
	RegexSensitiveFile = regexp.MustCompile(`(?i)(\.env(\..+)?|id_rsa|credentials\.json|\.aws\/credentials|\.ssh\/config|vault\.ya?ml|master\.key)`)
)

// Known sensitive application binary names / WM_CLASS (lowercase match).
var KnownSensitiveApps = map[string]string{
	"bitwarden":        "Password Manager (Bitwarden)",
	"1password":        "Password Manager (1Password)",
	"keepass":          "Password Manager (KeePass)",
	"keepassxc":        "Password Manager (KeePassXC)",
	"lastpass":         "Password Manager (LastPass)",
	"authy":            "Authenticator (Authy)",
	"dashlane":         "Password Manager (Dashlane)",
	"enpass":           "Password Manager (Enpass)",
	"roboform":         "Password Manager (RoboForm)",
	"tor browser":      "Tor Private Browser",
	"torbrowser":       "Tor Private Browser",
}

// PassesLuhn validates a potential credit card number using Luhn's algorithm.
func PassesLuhn(s string) bool {
	// Strip spaces and dashes
	var digits []int
	for _, ch := range s {
		if ch >= '0' && ch <= '9' {
			digits = append(digits, int(ch-'0'))
		} else if ch != ' ' && ch != '-' {
			return false
		}
	}
	if len(digits) < 10 || len(digits) > 19 {
		return false
	}

	sum := 0
	alternate := false
	for i := len(digits) - 1; i >= 0; i-- {
		n := digits[i]
		if alternate {
			n *= 2
			if n > 9 {
				n -= 9
			}
		}
		sum += n
		alternate = !alternate
	}
	return sum%10 == 0
}

// ScanSensitiveTokens scans text for secrets and returns reason if any matched.
func ScanSensitiveTokens(text string) (bool, string) {
	if text == "" {
		return false, ""
	}
	if RegexAWSAccessKey.MatchString(text) {
		return true, "AWS Access Key Detected"
	}
	if RegexGitHubToken.MatchString(text) {
		return true, "GitHub Personal Access Token Detected"
	}
	if RegexGoogleAPIKey.MatchString(text) {
		return true, "Google API Key Detected"
	}
	if RegexStripeKey.MatchString(text) {
		return true, "Stripe API Key Detected"
	}
	if RegexPrivateKey.MatchString(text) {
		return true, "Cryptographic Private Key Detected"
	}
	if RegexJWTToken.MatchString(text) {
		return true, "JWT Auth Token Detected"
	}
	if matches := RegexCreditCard.FindAllString(text, -1); len(matches) > 0 {
		for _, m := range matches {
			if PassesLuhn(m) {
				return true, "Payment Card Number Detected"
			}
		}
	}
	return false, ""
}

// RedactSensitiveTitle replaces sensitive keywords or strings in window titles for display/logs.
func RedactSensitiveTitle(title string) string {
	if title == "" {
		return ""
	}
	if RegexPasswordVault.MatchString(title) {
		return "🔒 [Password / Vault Window]"
	}
	if RegexBanking.MatchString(title) {
		return "🔒 [Financial / Banking Portal]"
	}
	if RegexIncognito.MatchString(title) {
		return "🔒 [Private / Incognito Session]"
	}
	if RegexSensitiveFile.MatchString(title) {
		return "🔒 [Protected Credentials File]"
	}
	return strings.TrimSpace(title)
}
