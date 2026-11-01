brandHeader('Menu', `${greeting()}. Have a look around and take your time. When you're ready, tell us at the counter, or sit down and scan the QR code on your table to order from your seat.`);
api('/api/menu').then((m) => renderMenu(document.getElementById('app'), m));
