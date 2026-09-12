"""SMTP delivery for the notification service: multipart text + HTML
(the HTML is the styled job card, the text is the same content for
clients that don't render HTML)."""
import smtplib
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

from shared_models.models import NotificationSettings


def send_email(settings: NotificationSettings, to_email: str, subject: str, body: str, html: str | None = None) -> None:
    """Delivers one message through the configured server: plain text,
    plus an HTML alternative when given (clients that render HTML show
    that; everything else gets the text). Raises on any connection/auth/
    refusal error -- the caller records that in the delivery log rather
    than this function swallowing it."""
    msg = EmailMessage()
    msg["From"] = settings.from_address
    msg["To"] = to_email
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain="voxellabel.local")
    msg.set_content(body)
    if html:
        msg.add_alternative(html, subtype="html")

    smtp_class = smtplib.SMTP_SSL if settings.smtp_use_ssl else smtplib.SMTP
    with smtp_class(settings.smtp_host, settings.smtp_port, timeout=20) as server:
        if settings.smtp_use_tls and not settings.smtp_use_ssl:
            server.starttls()
        if settings.smtp_username:
            server.login(settings.smtp_username, settings.smtp_password or "")
        server.send_message(msg)
