// Order statuses. `label`/`help` are what customers see on the tracking page; `admin` is the shop's short label.
export const STATUS = {
  new: { admin: 'New', label: 'Received', help: 'The shop has your order and will contact you on WhatsApp or call to confirm.' },
  confirmed: { admin: 'Confirmed', label: 'Confirmed', help: 'The shop confirmed your order and is packing it.' },
  ready: { admin: 'Ready', label: 'Ready for pickup', help: 'Your order is packed. Collect it at the stall and pay there.' },
  completed: { admin: 'Completed', label: 'Completed', help: 'Picked up. Happy Diwali!' },
  cancelled: { admin: 'Cancelled', label: 'Cancelled', help: 'This order was cancelled. Call the shop if this is unexpected.' },
};

export const STATUS_FLOW = ['new', 'confirmed', 'ready', 'completed'];
