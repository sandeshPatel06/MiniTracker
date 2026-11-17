package email

import (
	"bufio"
	"bytes"
	"fmt"
	"log"
	"net"
	"os"
	"strings"
	"testing"
)

// fakeSMTPServer starts an in-memory plain SMTP server on a local listener for testing.
func fakeSMTPServer(t *testing.T) (net.Listener, chan []string) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to listen on test port: %v", err)
	}

	cmdChan := make(chan []string, 20)

	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				reader := bufio.NewReader(c)
				fmt.Fprintf(c, "220 smtp.minitracker.test ESMTP Service Ready\r\n")

				var cmds []string
				inData := false
				var dataBuf bytes.Buffer

				for {
					line, err := reader.ReadString('\n')
					if err != nil {
						break
					}
					lineTrim := strings.TrimRight(line, "\r\n")

					if inData {
						if lineTrim == "." {
							inData = false
							cmds = append(cmds, "DATA_PAYLOAD:"+dataBuf.String())
							fmt.Fprintf(c, "250 OK message queued\r\n")
						} else {
							dataBuf.WriteString(lineTrim + "\n")
						}
						continue
					}

					cmds = append(cmds, lineTrim)
					upper := strings.ToUpper(lineTrim)

					switch {
					case strings.HasPrefix(upper, "EHLO") || strings.HasPrefix(upper, "HELO"):
						fmt.Fprintf(c, "250-smtp.minitracker.test\r\n250 HELP\r\n")
					case strings.HasPrefix(upper, "MAIL FROM:"):
						fmt.Fprintf(c, "250 OK\r\n")
					case strings.HasPrefix(upper, "RCPT TO:"):
						fmt.Fprintf(c, "250 OK\r\n")
					case upper == "DATA":
						inData = true
						dataBuf.Reset()
						fmt.Fprintf(c, "354 Start mail input; end with <CRLF>.<CRLF>\r\n")
					case upper == "QUIT":
						fmt.Fprintf(c, "221 Bye\r\n")
						cmdChan <- cmds
						return
					default:
						fmt.Fprintf(c, "500 Unrecognized command\r\n")
					}
				}
				cmdChan <- cmds
			}(conn)
		}
	}()

	return l, cmdChan
}

func TestValidateEmail(t *testing.T) {
	tests := []struct {
		email   string
		wantErr bool
	}{
		{"user@example.com", false},
		{"alice.bob+tag@company.co.uk", false},
		{"plainaddress", true},
		{"@missingusername.com", true},
		{"missingdomain@", true},
		{"", true},
		{"user@domain", true},
		{"   ", true},
	}

	for _, tt := range tests {
		t.Run(tt.email, func(t *testing.T) {
			err := ValidateEmail(tt.email)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateEmail(%q) error = %v, wantErr = %v", tt.email, err, tt.wantErr)
			}
		})
	}
}

func TestSanitizeHeader(t *testing.T) {
	input := "Subject Line\r\nBcc: hacker@example.com\nAnother-Header: 1"
	got := sanitizeHeader(input)
	if strings.Contains(got, "\r") || strings.Contains(got, "\n") {
		t.Errorf("sanitizeHeader failed to strip CRLF: %q", got)
	}
	expected := "Subject LineBcc: hacker@example.comAnother-Header: 1"
	if got != expected {
		t.Errorf("sanitizeHeader(%q) = %q, want %q", input, got, expected)
	}
}

func TestMailer_IsLiveMode(t *testing.T) {
	mSim := &Mailer{}
	if mSim.IsLiveMode() {
		t.Errorf("expected mSim to not be live mode")
	}

	mLive := &Mailer{
		Host: "smtp.example.com",
		Port: 587,
		From: "no-reply@example.com",
	}
	if !mLive.IsLiveMode() {
		t.Errorf("expected mLive to be live mode")
	}
}

func TestNewMailer_DefaultPort(t *testing.T) {
	os.Unsetenv("SMTP_PORT")
	os.Unsetenv("SMTP_HOST")
	os.Unsetenv("SMTP_USER")
	os.Unsetenv("SMTP_PASS")
	os.Unsetenv("SMTP_FROM")

	m := NewMailer()
	if m.Port != 587 {
		t.Errorf("expected default port 587, got %d", m.Port)
	}
	if m.IsLiveMode() {
		t.Errorf("expected default mailer to not be in live mode")
	}
}

func TestSendVerificationEmail_SimulationMode(t *testing.T) {
	m := &Mailer{}

	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	err := m.SendVerificationEmail("test@example.com", "849201")
	if err != nil {
		t.Fatalf("expected nil error in simulation mode, got %v", err)
	}

	output := buf.String()
	if !strings.Contains(output, "[MAILER SIMULATION]") {
		t.Errorf("log should contain simulation marker, got: %s", output)
	}
	if !strings.Contains(output, "849201") {
		t.Errorf("log should contain OTP code, got: %s", output)
	}
	if !strings.Contains(output, "10 minutes") {
		t.Errorf("log should contain expiry, got: %s", output)
	}
}

func TestSendVerificationEmail_Validation(t *testing.T) {
	m := &Mailer{}

	if err := m.SendVerificationEmail("invalid-email", "123456"); err == nil {
		t.Errorf("expected error for invalid email")
	}
	if err := m.SendVerificationEmail("test@example.com", ""); err == nil {
		t.Errorf("expected error for empty otp")
	}
}

func TestSendInviteEmail_SimulationMode(t *testing.T) {
	m := &Mailer{}

	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	err := m.SendInviteEmail("team@example.com", "Acme Corp", "Admin", "https://app.test/invite?token=xyz")
	if err != nil {
		t.Fatalf("expected nil error in simulation mode, got %v", err)
	}

	output := buf.String()
	if !strings.Contains(output, "[MAILER SIMULATION]") {
		t.Errorf("log should contain simulation marker, got: %s", output)
	}
	if !strings.Contains(output, "https://app.test/invite?token=xyz") {
		t.Errorf("log should contain invite URL, got: %s", output)
	}
}

func TestSendVerificationEmail_LiveSMTP(t *testing.T) {
	listener, cmdChan := fakeSMTPServer(t)
	defer listener.Close()

	host, portStr, _ := net.SplitHostPort(listener.Addr().String())
	port := 0
	fmt.Sscanf(portStr, "%d", &port)

	m := &Mailer{
		Host: host,
		Port: port,
		From: "noreply@minitracker.app",
	}

	err := m.SendVerificationEmail("developer@example.com", "938217")
	if err != nil {
		t.Fatalf("SendVerificationEmail failed on fake SMTP: %v", err)
	}

	cmds := <-cmdChan
	var foundMailFrom, foundRcptTo, foundOTP, foundExpiry, foundWarning bool
	for _, cmd := range cmds {
		if strings.HasPrefix(cmd, "MAIL FROM:<noreply@minitracker.app>") {
			foundMailFrom = true
		}
		if strings.HasPrefix(cmd, "RCPT TO:<developer@example.com>") {
			foundRcptTo = true
		}
		if strings.Contains(cmd, "938217") {
			foundOTP = true
		}
		if strings.Contains(cmd, "10 minutes") {
			foundExpiry = true
		}
		if strings.Contains(cmd, "Security notice: If you did not request this verification code") {
			foundWarning = true
		}
	}

	if !foundMailFrom {
		t.Errorf("MAIL FROM not received as expected. Commands: %v", cmds)
	}
	if !foundRcptTo {
		t.Errorf("RCPT TO not received as expected. Commands: %v", cmds)
	}
	if !foundOTP {
		t.Errorf("OTP payload was not sent. Commands: %v", cmds)
	}
	if !foundExpiry {
		t.Errorf("Expiry notice was not found in email payload. Commands: %v", cmds)
	}
	if !foundWarning {
		t.Errorf("Security warning was not found in email payload. Commands: %v", cmds)
	}
}
