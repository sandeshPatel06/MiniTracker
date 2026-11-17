package email

import (
	"crypto/tls"
	"errors"
	"fmt"
	"html"
	"log"
	"net"
	"net/mail"
	"net/smtp"
	"os"
	"strconv"
	"strings"
	"time"
)

// Mailer handles email dispatching with support for simulation and live SMTP (TLS/STARTTLS).
type Mailer struct {
	Host string
	Port int
	User string
	Pass string
	From string

	// dialer allows overriding network connection logic during tests.
	dialer func(network, addr string) (net.Conn, error)
}

// NewMailer creates a new Mailer initialized from environment variables:
// SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS, SMTP_FROM.
func NewMailer() *Mailer {
	portStr := os.Getenv("SMTP_PORT")
	port, _ := strconv.Atoi(portStr)
	if port == 0 {
		port = 587
	}
	return &Mailer{
		Host: strings.TrimSpace(os.Getenv("SMTP_HOST")),
		Port: port,
		User: strings.TrimSpace(os.Getenv("SMTP_USER")),
		Pass: os.Getenv("SMTP_PASS"),
		From: strings.TrimSpace(os.Getenv("SMTP_FROM")),
	}
}

// IsLiveMode returns true if the mailer has sufficient SMTP settings to attempt live transmission.
func (m *Mailer) IsLiveMode() bool {
	return m != nil && m.Host != "" && m.From != ""
}

// ValidateEmail verifies recipient email format against standard RFC 5322 specs.
func ValidateEmail(addr string) error {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return errors.New("email address cannot be empty")
	}
	parsed, err := mail.ParseAddress(addr)
	if err != nil {
		return fmt.Errorf("invalid email address format: %w", err)
	}
	// Extra validation on domain presence and characters
	parts := strings.Split(parsed.Address, "@")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" || !strings.Contains(parts[1], ".") {
		return errors.New("invalid email address domain")
	}
	return nil
}

// sanitizeHeader strips CR and LF to prevent SMTP header injection attacks.
func sanitizeHeader(value string) string {
	value = strings.ReplaceAll(value, "\r", "")
	value = strings.ReplaceAll(value, "\n", "")
	return strings.TrimSpace(value)
}

// buildMultipartMessage constructs a standard multipart/alternative email body with text and html versions.
func buildMultipartMessage(from, to, subject, textBody, htmlBody string) []byte {
	boundary := fmt.Sprintf("=_boundary_%d_%s", time.Now().UnixNano(), "minitracker")
	cleanFrom := sanitizeHeader(from)
	cleanTo := sanitizeHeader(to)
	cleanSubject := sanitizeHeader(subject)

	var b strings.Builder
	b.WriteString(fmt.Sprintf("From: %s\r\n", cleanFrom))
	b.WriteString(fmt.Sprintf("To: %s\r\n", cleanTo))
	b.WriteString(fmt.Sprintf("Subject: %s\r\n", cleanSubject))
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString(fmt.Sprintf("Content-Type: multipart/alternative; boundary=\"%s\"\r\n", boundary))
	b.WriteString("\r\n")

	// Plain text alternative
	b.WriteString(fmt.Sprintf("--%s\r\n", boundary))
	b.WriteString("Content-Type: text/plain; charset=\"UTF-8\"\r\n")
	b.WriteString("Content-Transfer-Encoding: 7bit\r\n\r\n")
	b.WriteString(textBody)
	b.WriteString("\r\n\r\n")

	// HTML alternative
	b.WriteString(fmt.Sprintf("--%s\r\n", boundary))
	b.WriteString("Content-Type: text/html; charset=\"UTF-8\"\r\n")
	b.WriteString("Content-Transfer-Encoding: 7bit\r\n\r\n")
	b.WriteString(htmlBody)
	b.WriteString("\r\n\r\n")

	b.WriteString(fmt.Sprintf("--%s--\r\n", boundary))
	return []byte(b.String())
}

// sendViaSMTP sends message bytes through an SMTP connection with TLS or STARTTLS support.
func (m *Mailer) sendViaSMTP(toEmail string, msg []byte) error {
	addr := fmt.Sprintf("%s:%d", m.Host, m.Port)
	tlsConfig := &tls.Config{
		ServerName: m.Host,
		MinVersion: tls.VersionTLS12,
	}

	dial := m.dialer
	if dial == nil {
		dial = func(network, address string) (net.Conn, error) {
			return net.DialTimeout(network, address, 15*time.Second)
		}
	}

	var client *smtp.Client

	// SMTPS (Implicit TLS, usually port 465)
	if m.Port == 465 {
		conn, err := dial("tcp", addr)
		if err != nil {
			return fmt.Errorf("failed to dial SMTP server at %s: %w", addr, err)
		}
		tlsConn := tls.Client(conn, tlsConfig)
		if err := tlsConn.Handshake(); err != nil {
			conn.Close()
			return fmt.Errorf("tls handshake failed with %s: %w", addr, err)
		}
		c, err := smtp.NewClient(tlsConn, m.Host)
		if err != nil {
			tlsConn.Close()
			return fmt.Errorf("failed to create smtp client: %w", err)
		}
		client = c
	} else {
		// Plain TCP connection with opportunistic STARTTLS upgrade (e.g. port 587, 25)
		conn, err := dial("tcp", addr)
		if err != nil {
			return fmt.Errorf("failed to dial SMTP server at %s: %w", addr, err)
		}
		c, err := smtp.NewClient(conn, m.Host)
		if err != nil {
			conn.Close()
			return fmt.Errorf("failed to create smtp client: %w", err)
		}
		client = c

		// Check for STARTTLS support
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(tlsConfig); err != nil {
				client.Close()
				return fmt.Errorf("starttls negotiation failed: %w", err)
			}
		}
	}
	defer client.Close()
	defer client.Quit()

	// Authenticate if credentials are provided
	if m.User != "" && m.Pass != "" {
		auth := smtp.PlainAuth("", m.User, m.Pass, m.Host)
		if err := client.Auth(auth); err != nil {
			return fmt.Errorf("smtp authentication failed: %w", err)
		}
	}

	if err := client.Mail(m.From); err != nil {
		return fmt.Errorf("smtp MAIL FROM failed: %w", err)
	}
	if err := client.Rcpt(toEmail); err != nil {
		return fmt.Errorf("smtp RCPT TO failed: %w", err)
	}

	w, err := client.Data()
	if err != nil {
		return fmt.Errorf("smtp DATA command failed: %w", err)
	}
	if _, err = w.Write(msg); err != nil {
		_ = w.Close()
		return fmt.Errorf("failed writing email payload: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("failed closing smtp data stream: %w", err)
	}

	return nil
}

// SendVerificationEmail dispatches a 6-digit OTP verification code or logs it in simulation mode.
func (m *Mailer) SendVerificationEmail(toEmail, otpCode string) error {
	toEmail = strings.TrimSpace(toEmail)
	otpCode = strings.TrimSpace(otpCode)

	if err := ValidateEmail(toEmail); err != nil {
		return fmt.Errorf("invalid recipient email: %w", err)
	}
	if otpCode == "" {
		return errors.New("otp code cannot be empty")
	}

	subject := fmt.Sprintf("%s is your Mini Tracker verification code", otpCode)

	plainText := fmt.Sprintf(`Mini Tracker Account Verification

Your verification code is: %s

This code is valid for 10 minutes.

Security notice: If you did not request this verification code, please ignore this email or contact support if you suspect unauthorized activity on your account.

--
Mini Tracker Team
https://minitracker.app
`, otpCode)

	htmlBody := fmt.Sprintf(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verification Code</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0b0f19; color: #f3f4f6; margin: 0; padding: 32px 16px; }
    .wrapper { max-width: 520px; margin: 0 auto; background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 32px; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4); }
    .brand { font-size: 20px; font-weight: 700; color: #38bdf8; display: inline-flex; align-items: center; margin-bottom: 24px; letter-spacing: -0.02em; }
    h1 { font-size: 20px; font-weight: 600; color: #ffffff; margin-top: 0; margin-bottom: 12px; }
    p { font-size: 14px; line-height: 1.6; color: #9ca3af; margin: 0 0 16px 0; }
    .otp-box { background: #1f2937; border: 1px solid #374151; border-radius: 10px; padding: 20px; text-align: center; margin: 28px 0; }
    .otp-code { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #38bdf8; user-select: all; }
    .expiry { font-size: 13px; color: #f59e0b; margin-top: 10px; font-weight: 500; }
    .warning { background: rgba(239, 68, 68, 0.1); border-left: 3px solid #ef4444; padding: 12px 16px; border-radius: 4px; margin-top: 24px; font-size: 13px; color: #d1d5db; line-height: 1.5; }
    .footer { margin-top: 32px; padding-top: 20px; border-top: 1px solid #1f2937; font-size: 12px; color: #6b7280; text-align: center; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="brand">⚡ Mini Tracker</div>
    <h1>Verify Your Email Address</h1>
    <p>Please enter the following one-time passcode (OTP) to complete your verification:</p>
    
    <div class="otp-box">
      <div class="otp-code">%s</div>
      <div class="expiry">⏱ Valid for 10 minutes</div>
    </div>

    <div class="warning">
      <strong>Security notice:</strong> If you did not request this verification code, please ignore this email. Never share this code with anyone.
    </div>

    <div class="footer">
      &copy; Mini Tracker &bull; Secure Productivity &amp; Activity Tracking
    </div>
  </div>
</body>
</html>`, html.EscapeString(otpCode))

	if !m.IsLiveMode() {
		log.Printf("==================================================")
		log.Printf("[MAILER SIMULATION] SMTP not configured.")
		log.Printf("[VERIFICATION OTP TO %s]: %s", toEmail, otpCode)
		log.Printf("[EXPIRY]: 10 minutes")
		log.Printf("==================================================")
		return nil
	}

	msg := buildMultipartMessage(m.From, toEmail, subject, plainText, htmlBody)
	if err := m.sendViaSMTP(toEmail, msg); err != nil {
		log.Printf("[MAILER ERROR] Failed to send verification email to %s: %v. Debug OTP: %s", toEmail, err, otpCode)
		return err
	}

	log.Printf("[MAILER SUCCESS] Verification email sent to %s", toEmail)
	return nil
}

// SendInviteEmail dispatches an invitation email or logs it if SMTP is unconfigured.
func (m *Mailer) SendInviteEmail(toEmail, orgName, role, inviteURL string) error {
	toEmail = strings.TrimSpace(toEmail)
	if err := ValidateEmail(toEmail); err != nil {
		return fmt.Errorf("invalid recipient email: %w", err)
	}

	cleanOrg := html.EscapeString(orgName)
	cleanRole := html.EscapeString(role)
	cleanInviteURL := html.EscapeString(inviteURL)
	subject := fmt.Sprintf("You're invited to join %s on Mini Tracker", sanitizeHeader(orgName))

	plainText := fmt.Sprintf(`Join %s on Mini Tracker

You have been invited to join %s as a %s on Mini Tracker.

Accept your invitation here:
%s

This invitation expires in 48 hours. If you did not expect this invite, please ignore this email.

--
Mini Tracker Team
`, orgName, orgName, role, inviteURL)

	htmlBody := fmt.Sprintf(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background-color: #0f172a; color: #f8fafc; margin: 0; padding: 40px; }
    .container { max-width: 560px; margin: 0 auto; background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 32px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
    .logo { font-size: 24px; font-weight: 700; color: #38bdf8; letter-spacing: -0.5px; margin-bottom: 24px; display: inline-block; }
    h1 { font-size: 20px; color: #f8fafc; margin-top: 0; margin-bottom: 12px; }
    p { font-size: 15px; color: #94a3b8; line-height: 1.6; margin-bottom: 24px; }
    .badge { display: inline-block; padding: 4px 10px; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 9999px; font-size: 13px; font-weight: 600; text-transform: uppercase; }
    .btn { display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 15px; text-align: center; }
    .footer { margin-top: 32px; font-size: 12px; color: #64748b; border-top: 1px solid #334155; padding-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">⚡ Mini Tracker Corporate Beta</div>
    <h1>Join %s</h1>
    <p>You have been invited to join <strong>%s</strong> as a <span class="badge">%s</span> on Mini Tracker Corporate Beta.</p>
    <p>Click below to complete your setup and join your team:</p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="%s" class="btn">Accept Invitation & Join Team</a>
    </div>
    <p style="font-size: 13px; color: #64748b;">Or copy this link into your browser:<br><a href="%s" style="color: #38bdf8;">%s</a></p>
    <div class="footer">
      This invitation expires in 48 hours. If you did not expect this invite, please ignore this email.
    </div>
  </div>
</body>
</html>`, cleanOrg, cleanOrg, cleanRole, cleanInviteURL, cleanInviteURL, cleanInviteURL)

	if !m.IsLiveMode() {
		log.Printf("--------------------------------------------------")
		log.Printf("[MAILER SIMULATION] SMTP not configured. Invite URL:")
		log.Printf("[INVITE TO %s]: %s", toEmail, inviteURL)
		log.Printf("--------------------------------------------------")
		return nil
	}

	msg := buildMultipartMessage(m.From, toEmail, subject, plainText, htmlBody)
	if err := m.sendViaSMTP(toEmail, msg); err != nil {
		log.Printf("[MAILER ERROR] Failed to send email to %s: %v. Fallback link: %s", toEmail, err, inviteURL)
		return nil // Graceful fallback so API succeeds for invites
	}

	log.Printf("[MAILER SUCCESS] Invitation sent to %s", toEmail)
	return nil
}
