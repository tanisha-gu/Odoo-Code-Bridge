# Odoo Code Bridge

Convert backend Python (or JavaScript) code into idiomatic **Odoo ORM Python code** — models, fields, and business-logic methods. No HTTP controllers or routes are ever generated; output is model-level code only (meant to be called from views, other models, server actions, or automated actions).

## What it does

- Paste plain Python or JavaScript backend/business logic into the left panel.
- Click the convert (→) button.
- Get back Odoo-style Python in the right panel: `models.Model` subclasses, `fields.Char` / `fields.Many2one` / etc., and decorators like `@api.model`, `@api.depends`, `@api.constrains`, `@api.onchange` where appropriate.
- If the input contains JavaScript, the underlying *logic* is reinterpreted into Odoo Python rather than transliterated line-by-line (e.g. a frontend validation becomes an `@api.constrains` method; a computed display value becomes an `@api.depends` compute method).

## How it works

This is a single self-contained React component (`odoo-code-bridge.jsx`). It has no backend server and defines no routes — conversion happens by calling the Anthropic Messages API (`api.anthropic.com/v1/messages`) directly from the browser with a system prompt that:

1. Targets Odoo ORM conventions specifically.
2. Explicitly forbids `@http.route`, Flask/Django/FastAPI-style routing, or any URL/endpoint definitions.
3. Asks for structured JSON output (`convertedCode`, `notes`, `detectedLanguage`) so the UI can render the code and a short explanation separately.

## Files

| File | Purpose |
|---|---|
| `odoo-code-bridge.jsx` | The full app — UI + conversion logic |
| `README.md` | This file |

## Running it

This component is built to run inside an environment that already provides:
- React (with hooks)
- `lucide-react` for icons
- A same-origin, authenticated path to `https://api.anthropic.com/v1/messages` (no API key needed to be supplied by you — the host environment handles auth)

If you want to run it as a **standalone app outside that environment** (e.g. your own Vite/Next.js project), you'll need to:

1. `npm install react lucide-react`
2. Drop `odoo-code-bridge.jsx` into your project and import/render it as the default export.
3. Provide your own Anthropic API key and proxy the request server-side (browsers can't safely call the Anthropic API directly with a secret key exposed) — you'll need a **thin backend route** for that in a real deployment. If you truly want zero backend, you can call the API from the browser using a key that's scoped/rate-limited for client-side use, but that's generally not recommended for production.
4. Replace the model string / `max_tokens` as needed for your own API usage limits.

## Usage notes / limitations

- **Always review the output.** This is LLM-generated code — check inferred field types, `_name`, relations (`Many2one` vs `One2many` vs `Many2many`), and access rules before dropping it into a real Odoo module.
- **Output is capped** at a fixed token budget per conversion. Very large files may get truncated — for big files, convert one class or function at a time.
- **No routes, ever.** By design, this tool will not generate `@http.route` controllers, even if your source code is a Flask/Django/Express route handler. It converts the *business logic* inside such handlers into Odoo model methods — you'd wire up any actual UI/controller layer separately in Odoo (views, server actions, etc.).
- Language hint (Auto / Python / JavaScript) is a hint to the model, not a strict parser — mixed-language snippets are supported.

## Example

Input:
```python
class Order:
    def __init__(self, customer_name, items):
        self.customer_name = customer_name
        self.items = items
        self.status = "draft"

    def total(self):
        return sum(item["price"] * item["qty"] for item in self.items)

    def confirm(self):
        if not self.items:
            raise ValueError("Cannot confirm an empty order")
        self.status = "confirmed"
        return self.status
```

Typical output shape (abbreviated):
```python
class SaleOrderCustom(models.Model):
    _name = "custom.sale.order"
    _description = "Custom Sale Order"

    customer_name = fields.Char(required=True)
    order_line_ids = fields.One2many("custom.sale.order.line", "order_id")
    status = fields.Selection([("draft", "Draft"), ("confirmed", "Confirmed")], default="draft")
    total = fields.Float(compute="_compute_total")

    @api.depends("order_line_ids.price", "order_line_ids.qty")
    def _compute_total(self):
        for record in self:
            record.total = sum(line.price * line.qty for line in record.order_line_ids)

    def action_confirm(self):
        for record in self:
            if not record.order_line_ids:
                raise ValidationError("Cannot confirm an empty order")
            record.status = "confirmed"
```
