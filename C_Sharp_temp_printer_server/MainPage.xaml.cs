using System.Collections.Concurrent;
using System.Collections.ObjectModel;
using System.Linq;
using System.Text;
using System.Text.Json;
using SocketIOClient;
using Microsoft.Maui.Storage;
using System.Runtime.InteropServices;
#if WINDOWS
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Input;
#endif
using CommunityToolkit.Maui.Alerts;
using CommunityToolkit.Maui.Core;

namespace C_Sharp_temp_printer_server;

public partial class MainPage : ContentPage
{
	private enum Scene { Restaurant, Employee, Printer }

	private void ShowScene(Scene scene)
	{
		MainThread.BeginInvokeOnMainThread(() =>
		{
			RestaurantScene.IsVisible = scene == Scene.Restaurant;
			EmployeeScene.IsVisible = scene == Scene.Employee;
			PrinterScene.IsVisible = scene == Scene.Printer;
			try { QueueScene.IsVisible = scene == Scene.Printer; } catch { }
		});
	}

	private async Task RunWithSpinner(Func<Task> action)
	{
		try
		{
			MainThread.BeginInvokeOnMainThread(() => { LoadingIndicator.IsVisible = true; LoadingIndicator.IsRunning = true; });
			await action();
		}
		catch (Exception ex)
		{
			Log("Action error: " + ex.Message);
		}
		finally
		{
			MainThread.BeginInvokeOnMainThread(() => { LoadingIndicator.IsVisible = false; LoadingIndicator.IsRunning = false; });
		}
	}
	class PrintJob
	{
		public string BillId { get; set; } = "";
		public byte[] Data { get; set; } = Array.Empty<byte>();
		public int Attempts { get; set; } = 0;
		public int MaxAttempts { get; set; } = 3;
		public bool IsCancelled { get; set; } = false;
		public string Display => $"{BillId} - {Data.Length} bytes (attempts:{Attempts})";
	}

	private readonly HttpClient _http = new HttpClient();
	private SocketIO? _socket;
	private readonly ConcurrentQueue<PrintJob> _queue = new ConcurrentQueue<PrintJob>();
	private readonly ObservableCollection<PrintJob> _pendingList = new ObservableCollection<PrintJob>();
	private readonly ObservableCollection<string> _logs = new ObservableCollection<string>();
	private CancellationTokenSource? _printerLoopCts;
	private PrintJob? _selectedJob;
	private bool _isPaused = false;

	public MainPage()
	{
		InitializeComponent();
		QueueList.ItemsSource = _pendingList;
		LogsList.ItemsSource = _logs;
	}

	protected override async void OnAppearing()
	{
		base.OnAppearing();
		var backend = await ReadBackendUrlFromAssets() ?? "http://localhost:3000";
		_http.BaseAddress = new Uri(backend);
		ConnectionStatus.Text = $"Backend: {backend}";
		Log($"Backend set to {backend}");
		ShowScene(Scene.Restaurant);
		AttachPlatformHoverCursors();
	}

	private void AttachPlatformHoverCursors()
	{
#if WINDOWS
		try
		{
			AttachWinHover(VerifyRestaurantBtn);
			AttachWinHover(EmployeeLoginBtn);
			AttachWinHover(LogoutBtn_Emp);
			AttachWinHover(DiscoverPrintersBtn);
			AttachWinHover(LogoutBtn_Printer);
			AttachWinHover(SetDefaultPrinterBtn);
		}
		catch (Exception ex) { Log("Attach hover error: " + ex.Message); }
#endif
	}

#if WINDOWS
	[DllImport("user32.dll")]
	private static extern IntPtr LoadCursor(IntPtr hInstance, int lpCursorName);
	[DllImport("user32.dll")]
	private static extern IntPtr SetCursor(IntPtr hCursor);
	private const int IDC_ARROW = 32512;
	private const int IDC_HAND = 32649;

	private void AttachWinHover(Microsoft.Maui.Controls.Button btn)
	{
		if (btn?.Handler?.PlatformView is Microsoft.UI.Xaml.FrameworkElement native)
		{
			native.PointerEntered += Native_PointerEntered;
			native.PointerExited += Native_PointerExited;
		}
	}

	private void Native_PointerEntered(object sender, PointerRoutedEventArgs e)
	{
		try { SetCursor(LoadCursor(IntPtr.Zero, IDC_HAND)); }
		catch { }
	}

	private void Native_PointerExited(object sender, PointerRoutedEventArgs e)
	{
		try { SetCursor(LoadCursor(IntPtr.Zero, IDC_ARROW)); }
		catch { }
	}
#endif

	private async Task<string?> ReadBackendUrlFromAssets()
	{
		try
		{
			var candidates = new[] { ".env", "backend.env", "app.env" };
			foreach (var file in candidates)
			{
				try
				{
					using var s = await FileSystem.OpenAppPackageFileAsync(file);
					using var sr = new StreamReader(s);
					var content = await sr.ReadToEndAsync();
					foreach (var line in content.Split('\n'))
					{
						var parts = line.Split('=', 2);
						if (parts.Length == 2 && parts[0].Trim() == "BACKEND_URL") return parts[1].Trim();
					}
				}
				catch { }
			}
		}
		catch { }
		return null;
	}

	private void OnVerifyRestaurant(object? sender, EventArgs e)
	{
		_ = RunWithSpinner(VerifyRestaurantAsync);
	}

	private async Task VerifyRestaurantAsync()
	{
		try
		{
			var restaurant = RestaurantEntry.Text?.Trim();
			if (string.IsNullOrEmpty(restaurant)) { await ShowToastAsync("Enter restaurant id"); return; }

			var req = new HttpRequestMessage(HttpMethod.Get, $"/restaurant/profile?restaurantId={Uri.EscapeDataString(restaurant)}");
			req.Headers.Add("X-Restaurant-Id", restaurant);
			var resp = await _http.SendAsync(req);
			if (!resp.IsSuccessStatusCode) { RestaurantStatus.Text = "Invalid restaurant"; RestaurantStatus.TextColor = Colors.Red; Log("Restaurant verification failed"); return; }

			RestaurantStatus.Text = "Verified";
			RestaurantStatus.TextColor = Colors.Green;
			Preferences.Default.Set("restaurant_id_temp", restaurant);
			Log($"Restaurant {restaurant} verified");
			await ShowToastAsync("Restaurant verified");
			ShowScene(Scene.Employee);
		}
		catch (Exception ex)
		{
			Log("Verify error: " + ex.Message);
			await ShowToastAsync("Error verifying restaurant");
		}
	}

	private void OnEmployeeLogin(object? sender, EventArgs e)
	{
		_ = RunWithSpinner(EmployeeLoginAsync);
	}

	private async Task EmployeeLoginAsync()
	{
		try
		{
			var user = EmployeeEntry.Text?.Trim();
			var pass = PasswordEntry.Text ?? string.Empty;
			var restaurant = Preferences.Default.Get("restaurant_id_temp", string.Empty);
			if (string.IsNullOrEmpty(restaurant)) { await ShowToastAsync("Verify restaurant first"); return; }
			if (string.IsNullOrEmpty(user) || string.IsNullOrEmpty(pass)) { await ShowToastAsync("Enter credentials"); return; }

			var payload = new { employeeUsername = user, password = pass, restaurantName = restaurant };
			var resp = await _http.PostAsync("/auth/employee-login", new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json"));
			if (!resp.IsSuccessStatusCode) { var t = await resp.Content.ReadAsStringAsync(); Log($"Login failed: {t}"); await ShowToastAsync("Login failed"); return; }

			var txt = await resp.Content.ReadAsStringAsync();
			var doc = JsonDocument.Parse(txt).RootElement;
			var res_id = doc.GetProperty("res_id").GetString();
			var outlet_id = doc.GetProperty("outlet_id").GetString();
			var emp_id = doc.GetProperty("employeeId").GetString();
			var res_name = doc.GetProperty("restaurantName").GetString();
			var res_username = doc.GetProperty("employeeUsername").GetString();

			Preferences.Default.Set("res_id", res_id ?? "");
			Preferences.Default.Set("outlet_id", outlet_id ?? "");
			Preferences.Default.Set("emp_id", emp_id ?? "");
			Preferences.Default.Set("res_name", res_name ?? "");
			Preferences.Default.Set("res_username", res_username ?? "");

			EmployeeStatus.Text = $"Signed in: {res_username}";
			EmployeeStatus.TextColor = Colors.Green;
			Log($"Employee {res_username} signed in for {res_name}");
			await ShowToastAsync("Signed in");

			Log($"Connecting realtime for restaurant {res_id} outlet {outlet_id}");
			await ConnectSocketAndSubscribe(res_id ?? string.Empty, outlet_id ?? string.Empty);
			ShowScene(Scene.Printer);
		}
		catch (Exception ex)
		{
			Log("Login error: " + ex.Message);
			await ShowToastAsync("Error signing in");
		}
	}

	private async Task ConnectSocketAndSubscribe(string resId, string outletId)
	{
		try
		{

			// Create socket using server base address (Uri).
			// Provide auth with restaurant GUID so server-side handshake joins the correct restaurant:<resId> room.
			_socket = new SocketIO(_http.BaseAddress!, new SocketIOOptions { Auth = new { restaurantId = resId } });

			// When underlying client connects, join the outlet room
			_socket.OnConnected += async (s, e) =>
			{
				MainThread.BeginInvokeOnMainThread(() => ConnectionStatus.Text = "Connected to realtime");
				Log("Socket connected");
				try
				{
					await _socket.EmitAsync("joinOutlet", new object[] { new { restaurantId = resId, outletId = outletId } });
					await ShowToastAsync("Connected to realtime");
					Log($"Printer app connected for restaurant {resId} outlet {outletId}");
				}
				catch (Exception ex) { Log("Emit joinOutlet failed: " + ex.Message); }
			};

			_socket.OnDisconnected += (s, e) =>
			{
				MainThread.BeginInvokeOnMainThread(() => ConnectionStatus.Text = "Disconnected");
				Log("Socket disconnected");
				MainThread.BeginInvokeOnMainThread(() => { _ = ShowToastAsync("Disconnected from realtime"); });
			};

			_socket.On("bill:print", async (response) =>
			{
				try
				{
					object? raw = null;
					try { raw = response.GetValue<object>(0); } catch { raw = null; }

					JsonElement payloadElement;
					if (raw is string s)
					{
						if (string.IsNullOrEmpty(s)) { Log("Received empty string payload for bill:print"); return; }
						payloadElement = JsonDocument.Parse(s).RootElement;
					}
					else if (raw is JsonElement je)
					{
						payloadElement = je;
					}
					else if (raw != null)
					{
						// fallback: serialize the object and parse
						var ser = JsonSerializer.Serialize(raw);
						payloadElement = JsonDocument.Parse(ser).RootElement;
					}
					else
					{
						Log("Received null payload for bill:print");
						return;
					}

					// extract fields
					var billId = payloadElement.TryGetProperty("billId", out var p1) ? p1.GetString() : null;
					var b64 = payloadElement.TryGetProperty("escBase64", out var p2) ? p2.GetString() : null;
					if (string.IsNullOrEmpty(b64)) { Log("bill:print missing escBase64"); return; }
					var bytes = Convert.FromBase64String(b64!);
					var job = new PrintJob { BillId = billId ?? ("bill_" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()), Data = bytes };
					Log($"Received bill event: {job.BillId}");
					_queue.Enqueue(job);
					MainThread.BeginInvokeOnMainThread(() => { _pendingList.Add(job); _ = ShowToastAsync($"Bill {job.BillId} queued"); Log($"Queued {job.BillId}"); });
					StartPrinterLoopIfNeeded();
					return;
				}
				catch (Exception ex) { Log("Queue event error: " + ex.Message); return; }
			});

			// Listen for server ack when joining outlet
			_socket.On("joinedOutlet", async (response) =>
			{
				try
				{
					object? raw = null;
					try { raw = response.GetValue<object>(0); } catch { raw = null; }
					var ser = raw != null ? JsonSerializer.Serialize(raw) : "<null>";
					Log($"joinedOutlet ack: {ser}");
				}
				catch (Exception ex) { Log("joinedOutlet handler error: " + ex.Message); }
			});

			await _socket.ConnectAsync();
		}
		catch (Exception ex)
		{
			Log("Socket Error: " + ex.Message);
			await ShowToastAsync("Socket Error");
		}
	}

	private void StartPrinterLoopIfNeeded()
	{
		if (_printerLoopCts != null) return;
		_printerLoopCts = new CancellationTokenSource();
		_ = Task.Run(() => PrinterLoopAsync(_printerLoopCts.Token));
		Log("Printer loop started");
	}

	private async Task PrinterLoopAsync(CancellationToken ct)
	{
		while (!ct.IsCancellationRequested)
		{
			if (_isPaused)
			{
				await Task.Delay(500, ct);
				continue;
			}

			if (_queue.TryDequeue(out var job))
			{
				// remove from pending list on UI
				MainThread.BeginInvokeOnMainThread(() => { if (_pendingList.Contains(job)) _pendingList.Remove(job); });

				if (job.IsCancelled) { Log($"Job {job.BillId} cancelled, skipping"); continue; }

				Log($"Printing {job.BillId} (attempt {job.Attempts+1})");
				MainThread.BeginInvokeOnMainThread(() => { _ = ShowToastAsync($"Printing {job.BillId}"); });

				var defaultPrinter = Preferences.Default.Get("default_printer", string.Empty);
				if (string.IsNullOrEmpty(defaultPrinter))
				{
					// requeue and wait
					job.Attempts++;
					if (job.Attempts < job.MaxAttempts)
					{
						_queue.Enqueue(job);
						MainThread.BeginInvokeOnMainThread(() => { _pendingList.Add(job); });
						Log($"No default printer yet. Requeued {job.BillId}");
						await Task.Delay(2000, ct);
						continue;
					}
					else
					{
						Log($"Dropping {job.BillId} after {job.Attempts} attempts (no printer)");
						continue;
					}
				}

				try
				{
					var ok = RawPrinterHelper.SendBytesToPrinter(defaultPrinter, job.Data);
					if (!ok)
					{
						throw new Exception("SendBytesToPrinter returned false");
					}
					Log($"Printed {job.BillId} to {defaultPrinter}");
					MainThread.BeginInvokeOnMainThread(() => { _ = ShowToastAsync($"Printed {job.BillId}"); });
				}
				catch (Exception ex)
				{
					job.Attempts++;
					Log($"Print failed for {job.BillId}: {ex.Message}");
					if (job.Attempts < job.MaxAttempts && !job.IsCancelled)
					{
						_queue.Enqueue(job);
						MainThread.BeginInvokeOnMainThread(() => { _pendingList.Add(job); });
						Log($"Requeued {job.BillId} (attempt {job.Attempts})");
						await Task.Delay(2000, ct);
					}
					else
					{
						Log($"Giving up on {job.BillId} after {job.Attempts} attempts");
					}
				}
			}
			else
			{
				await Task.Delay(500, ct);
			}
		}
	}

	private void OnDiscoverPrinters(object? sender, EventArgs e)
	{
		_ = RunWithSpinner(DiscoverPrintersAsync);
	}

	private Task DiscoverPrintersAsync()
	{
		PrinterPicker.Items.Clear();
		try
		{
			foreach (var printer in System.Drawing.Printing.PrinterSettings.InstalledPrinters)
			{
				PrinterPicker.Items.Add(printer.ToString());
			}
			PrinterStatus.Text = "Discovered printers";
			Log("Printers discovered");
		}
		catch (Exception ex)
		{
			PrinterStatus.Text = "Error discovering printers";
			Log("Discover printers error: " + ex.Message);
			_ = ShowToastAsync("Error discovering printers");
		}
		return Task.CompletedTask;
	}

	private void OnSetDefaultPrinter(object? sender, EventArgs e)
	{
		_ = RunWithSpinner(SetDefaultPrinterAsync);
	}

	private Task SetDefaultPrinterAsync()
	{
		var sel = PrinterPicker.SelectedItem as string;
		if (string.IsNullOrEmpty(sel)) { _ = ShowToastAsync("Select a printer"); return Task.CompletedTask; }
		Preferences.Default.Set("default_printer", sel);
		PrinterStatus.Text = $"Default: {sel}";
		Log($"Default printer set to {sel}");
		StartPrinterLoopIfNeeded();
		return Task.CompletedTask;
	}

	private async void OnLogoutClicked(object? sender, EventArgs e)
	{
		await RunWithSpinner(async () =>
		{
			await DisconnectSocket();
			Preferences.Default.Remove("res_id");
			Preferences.Default.Remove("outlet_id");
			Preferences.Default.Remove("emp_id");
			Preferences.Default.Remove("res_name");
			Preferences.Default.Remove("res_username");
			Preferences.Default.Remove("restaurant_id_temp");
			EmployeeStatus.Text = "Not signed in";
			EmployeeStatus.TextColor = Colors.Gray;
			PrinterStatus.Text = "No default printer selected";
			Log("Logged out");
			ShowScene(Scene.Restaurant);
			await ShowToastAsync("Logged out");
		});
	}

	private async Task DisconnectSocket()
	{
		try
		{
			if (_socket != null)
			{
				try { await _socket.DisconnectAsync(); } catch { }
				_socket = null;
				Log("Realtime disconnected");
			}
		}
		catch (Exception ex) { Log("Disconnect error: " + ex.Message); }
	}

	private async Task ShowToastAsync(string message, ToastDuration duration = ToastDuration.Short)
	{
		try
		{
			var toast = Toast.Make(message, duration);
			await toast.Show();
		}
		catch { }
	}

	private void Log(string message)
	{
		var entry = $"[{DateTime.Now:HH:mm:ss}] {message}";
		MainThread.BeginInvokeOnMainThread(() => { _logs.Insert(0, entry); });
		Console.WriteLine(entry);
	}

	// Queue UI handlers
	private void OnQueueSelectionChanged(object? sender, SelectionChangedEventArgs e)
	{
		_selectedJob = e.CurrentSelection.FirstOrDefault() as PrintJob;
	}

	private void OnRetrySelected(object? sender, EventArgs e)
	{
		if (_selectedJob == null) { _ = ShowToastAsync("No job selected"); return; }
		_selectedJob.Attempts = 0;
		_selectedJob.IsCancelled = false;
		_queue.Enqueue(_selectedJob);
		if (!_pendingList.Contains(_selectedJob)) _pendingList.Add(_selectedJob);
		Log($"Retry requested for {_selectedJob.BillId}");
		_ = ShowToastAsync("Retry queued");
		StartPrinterLoopIfNeeded();
	}

	private void OnRemoveSelected(object? sender, EventArgs e)
	{
		if (_selectedJob == null) { _ = ShowToastAsync("No job selected"); return; }
		_selectedJob.IsCancelled = true;
		if (_pendingList.Contains(_selectedJob)) _pendingList.Remove(_selectedJob);
		Log($"Removed job {_selectedJob.BillId}");
		_ = ShowToastAsync("Removed");
	}

	private void OnClearQueue(object? sender, EventArgs e)
	{
		foreach (var j in _pendingList.ToList()) j.IsCancelled = true;
		_pendingList.Clear();
		Log("Cleared queue");
		_ = ShowToastAsync("Queue cleared");
	}

	private void OnPauseResume(object? sender, EventArgs e)
	{
		_isPaused = !_isPaused;
		PauseBtn.Text = _isPaused ? "Resume" : "Pause";
		Log(_isPaused ? "Printer loop paused" : "Printer loop resumed");
	}
}

// Raw printing helper for Windows (P/Invoke to Winspool)
internal static class RawPrinterHelper
{
	[System.Runtime.InteropServices.DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true)]
	private static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);

	[System.Runtime.InteropServices.DllImport("winspool.Drv", SetLastError = true)]
	private static extern bool ClosePrinter(IntPtr hPrinter);

	[System.Runtime.InteropServices.DllImport("winspool.Drv", SetLastError = true)]
	private static extern bool StartDocPrinter(IntPtr hPrinter, int level, IntPtr di);

	[System.Runtime.InteropServices.DllImport("winspool.Drv", SetLastError = true)]
	private static extern bool EndDocPrinter(IntPtr hPrinter);

	[System.Runtime.InteropServices.DllImport("winspool.Drv", SetLastError = true)]
	private static extern bool StartPagePrinter(IntPtr hPrinter);

	[System.Runtime.InteropServices.DllImport("winspool.Drv", SetLastError = true)]
	private static extern bool EndPagePrinter(IntPtr hPrinter);

	[System.Runtime.InteropServices.DllImport("winspool.Drv", SetLastError = true)]
	private static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

	public static bool SendBytesToPrinter(string printerName, byte[] bytes)
	{
		IntPtr pBytes = IntPtr.Zero;
		IntPtr hPrinter = IntPtr.Zero;
		try
		{
			if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) return false;
			int dwWritten = 0;
			pBytes = System.Runtime.InteropServices.Marshal.AllocCoTaskMem(bytes.Length);
			System.Runtime.InteropServices.Marshal.Copy(bytes, 0, pBytes, bytes.Length);
			bool started = StartDocPrinter(hPrinter, 1, IntPtr.Zero);
			StartPagePrinter(hPrinter);
			WritePrinter(hPrinter, pBytes, bytes.Length, out dwWritten);
			EndPagePrinter(hPrinter);
			EndDocPrinter(hPrinter);
			return true;
		}
		finally
		{
			if (pBytes != IntPtr.Zero) System.Runtime.InteropServices.Marshal.FreeCoTaskMem(pBytes);
			if (hPrinter != IntPtr.Zero) ClosePrinter(hPrinter);
		}
	}
}
