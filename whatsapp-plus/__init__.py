"""whatsapp-plus: the WhatsApp platform extended by subclassing + the whatsapp_* agent tools, as one native plugin."""
from .platform_plus import register_platform_plus
from .tools import register_tools


def register(ctx) -> None:
    register_platform_plus(ctx)
    register_tools(ctx)
