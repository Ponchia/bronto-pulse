const form = document.querySelector('#login-form');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.querySelector('#login-error');
  error.hidden = true;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const response = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(new FormData(form)),
      credentials: 'same-origin',
    });
    if (response.ok) {
      location.assign('/');
      return;
    }
    error.textContent = 'The access token was rejected. Check the private server configuration.';
    error.hidden = false;
  } catch {
    error.textContent = 'Cannot reach the reporting service. Try again.';
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});
