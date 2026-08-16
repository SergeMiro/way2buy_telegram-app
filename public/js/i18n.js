/* Way2Buy interface localization — English (US) and Russian. */
(function () {
  'use strict';

  var STORAGE_KEY = 'w2b:locale';
  var SUPPORTED = ['en', 'ru'];

  // Ukrainian remains the authoring language in the zero-build templates. The
  // translator works on complete UI phrases (longest first), which also covers
  // dynamic sentences assembled around an amount, name or count.
  var entries = [
    ['ваша річ уже існує', 'your piece already exists', 'ваша вещь уже существует'],
    ['ваша', 'your', 'ваша'], ['річ', 'piece', 'вещь'], ['уже', 'already', 'уже'], ['існує', 'exists', 'существует'],

    // ── analytics ──
    ['Аналітика', 'Analytics', 'Аналитика'],
    ['Примірочна за півроку', 'Fitting room, six months', 'Примерочная за полгода'],
    ['додали', 'added', 'добавили'], ['спитали', 'asked', 'спросили'], ['мовчки', 'in silence', 'молча'],
    ['Різниця між «додали» і «спитали» — це те, чого хочуть, але про що не написали менеджеру.',
      'The gap between “added” and “asked” is what people want but never mentioned to the manager.',
      'Разница между «добавили» и «спросили» — это то, чего хотят, но о чём не написали менеджеру.'],
    ['По місяцях', 'By month', 'По месяцам'],
    ['Ширина стовпчика — скільки додали, темна частина — про скільки спитали.',
      'Bar width is how many were added; the filled part is how many were asked about.',
      'Ширина столбца — сколько добавили, тёмная часть — о скольких спросили.'],
    ['Що з цим робити', 'What to do about it', 'Что с этим делать'],
    ['додати', 'stock more', 'добавить'], ['перевірити', 'check', 'проверить'], ['тихо', 'quiet', 'тихо'],
    ['Даних поки замало для висновків.', 'Not enough data to draw conclusions yet.',
      'Данных пока мало для выводов.'],
    ['Категорії', 'Categories', 'Категории'], ['Бренди', 'Brands', 'Бренды'],
    ['Позиції цього місяця', 'Items this month', 'Позиции этого месяца'],
    ['Цього місяця в примірочну ще нічого не додавали.',
      'Nothing has been added to the fitting room this month yet.',
      'В этом месяце в примерочную ещё ничего не добавляли.'],
    ['Рахуємо…', 'Calculating…', 'Считаем…'],

    ['Каталоги', 'Shop', 'Каталоги'], ['Стрічка', 'Feed', 'Лента'],
    ['Примірочна', 'Fitting room', 'Примерочная'], ['Знижки', 'Offers', 'Скидки'],
    ['Кабінет', 'Admin', 'Кабинет'], ['Повідомлення', 'Notifications', 'Уведомления'],
    ['Мова інтерфейсу', 'Interface language', 'Язык интерфейса'],
    ['Менеджер', 'Manager', 'Менеджер'], ['менеджеру', 'the manager', 'менеджеру'],
    ['менеджер Way2Buy', 'Way2Buy manager', 'менеджер Way2Buy'],
    ['Даші', 'Dasha', 'Даше'], ['Даша', 'Dasha', 'Даша'],
    ['Вітаємо у Way2Buy', 'Welcome to Way2Buy', 'Добро пожаловать в Way2Buy'],
    ['Гість', 'Guest', 'Гость'], ['покупок', 'purchases', 'покупок'],
    ['Клуб Way2Buy', 'Way2Buy Club', 'Клуб Way2Buy'],
    ['Імʼя та прізвище', 'Full name', 'Имя и фамилия'],
    ['З Telegram ✓', 'From Telegram ✓', 'Из Telegram ✓'],
    ['Ваше імʼя', 'Your name', 'Ваше имя'],
    ['Адреса доставки', 'Delivery address', 'Адрес доставки'],
    ['Місто, вулиця, будинок, квартира', 'City, street, building, apartment', 'Город, улица, дом, квартира'],
    ['Номер телефону', 'Phone number', 'Номер телефона'],
    ['Дата народження', 'Date of birth', 'Дата рождения'],
    ['Імʼя вже заповнено. Телефон і адресу може запропонувати ваш пристрій.',
      'Your name is filled in. Your device may suggest your phone number and address.',
      'Имя уже заполнено. Телефон и адрес может предложить ваше устройство.'],
    ['Дату народження ми записуємо один раз — вона потрібна для знижки і надалі не змінюється без менеджера.',
      'We save your date of birth once. It is used for your discount and can only be changed by a manager.',
      'Дату рождения мы сохраняем один раз. Она нужна для скидки и меняется только через менеджера.'],
    ['Погоджуюсь отримувати повідомлення про знижки',
      'I agree to receive discount notifications', 'Согласен получать уведомления о скидках'],
    ['Приєднатися до клубу', 'Join the club', 'Вступить в клуб'],
    ['бонусу за покупку від', 'bonus on a purchase of', 'бонус за покупку от'],
    ['знижка на день народження', 'birthday discount', 'скидка ко дню рождения'],
    ['і вся стрічка каналу в одному місці.', 'and the full channel feed in one place.', 'и вся лента канала в одном месте.'],

    ['Пошук за назвою або артикулом', 'Search by name or item number', 'Поиск по названию или артикулу'],
    ['Очистити', 'Clear', 'Очистить'], ['Прибрати фільтр', 'Remove filter', 'Снять фильтр'],
    ['Прибрати', 'Remove', 'Удалить'], ['Усе', 'All', 'Все'], ['Усі каталоги', 'All catalogs', 'Все каталоги'],
    ['Товари в наявності', 'In stock', 'В наличии'], ['В наявності', 'In stock', 'В наличии'],
    ['Аксесуари', 'Accessories', 'Аксессуары'], ['Одяг жіночий', "Women's clothing", 'Женская одежда'],
    ['Чоловічий одяг', "Men's clothing", 'Мужская одежда'], ['Годинники', 'Watches', 'Часы'],
    ['Сумки жіночі', "Women's bags", 'Женские сумки'], ['Взуття жіноче', "Women's shoes", 'Женская обувь'],
    ['Прикраси', 'Jewelry', 'Украшения'], ['Чоловіче взуття', "Men's shoes", 'Мужская обувь'],
    ['Шкіра та хутро', 'Leather & fur', 'Кожа и мех'], ['Гаманці', 'Wallets', 'Кошельки'],
    ['Коштовні прикраси', 'Fine jewelry', 'Ювелирные украшения'],
    ['Скинути все', 'Clear all', 'Сбросить всё'], ['Фільтри', 'Filters', 'Фильтры'],
    ['Бренд', 'Brand', 'Бренд'], ['Категорія', 'Category', 'Категория'], ['Готово', 'Done', 'Готово'],
    ['Тут поки нема за чим фільтрувати.', 'No filters are available here yet.', 'Здесь пока нет доступных фильтров.'],
    ['Пошук', 'Search', 'Поиск'], ['позиція', 'item', 'позиция'], ['позиції', 'items', 'позиции'], ['позицій', 'items', 'позиций'],
    ['За цим фільтром нічого немає', 'No items match this filter', 'По этому фильтру ничего нет'],
    ['У цьому каталозі ще немає позицій', 'There are no items in this catalog yet', 'В этом каталоге пока нет товаров'],
    ['нічого не знайшли', 'returned no results', 'ничего не найдено'], ['За запитом', 'Search for', 'По запросу'],
    ['Завантажую…', 'Loading…', 'Загрузка…'], ['Завантаження…', 'Loading…', 'Загрузка…'],
    ['Показати ще', 'Show more', 'Показать ещё'], ['Хочу', 'I want it', 'Хочу'],
    ['У примірочній ✓', 'In fitting room ✓', 'В примерочной ✓'], ['У примірочній', 'In fitting room', 'В примерочной'],
    ['Позиція', 'Item', 'Позиция'], ['арт.', 'item no.', 'арт.'],
    ['У стрічці ще немає публікацій.', 'There are no posts in the feed yet.', 'В ленте пока нет публикаций.'],

    ['Примірочна порожня. Відкрийте «Каталоги», натисніть «Хочу цю позицію» — і всі обрані речі зберуться тут.',
      'Your fitting room is empty. Open Shop and tap “I want it” to collect items here.',
      'Примерочная пуста. Откройте «Каталоги» и нажмите «Хочу» — выбранные вещи появятся здесь.'],
    ['Обрані позиції', 'Selected items', 'Выбранные позиции'],
    ['Знижку застосовано автоматично', 'Discount applied automatically', 'Скидка применена автоматически'],
    ['Знижка вже ваша', 'Your discount is ready', 'Ваша скидка уже доступна'],
    ['діє від замовлення', 'applies to orders of', 'действует при заказе от'],
    ['застосуємо при замовленні', 'we will apply it to your order', 'применим при оформлении заказа'],
    ['Можете дописати, що саме вас цікавить', 'Add any details about what you are looking for', 'Можете добавить, что именно вас интересует'],
    ['отримає це повідомлення разом зі списком обраних позицій.',
      'will receive this message with your selected items.', 'получит это сообщение со списком выбранных позиций.'],
    ['Відправити', 'Send to', 'Отправить'], ['Або напишіть', 'Or message', 'Или напишите'],
    ['напряму', 'directly', 'напрямую'], ['Написати', 'Message', 'Написать'],
    ['Дякуємо! Ваш запит уже в роботі —', 'Thank you! Your request is already being handled —', 'Спасибо! Ваш запрос уже в работе —'],
    ['звʼяжеться з вами найближчим часом.', 'will contact you shortly.', 'свяжется с вами в ближайшее время.'],
    ['Вашу знижку', 'Your discount', 'Ваша скидка'], ['враховано', 'has been applied', 'учтена'], ['Добре', 'OK', 'Хорошо'],

    ['бонусів доступно до списання', 'bonus available to redeem', 'бонусов доступно к списанию'],
    ['Правило: покупка від', 'Rule: purchase of', 'Правило: покупка от'],
    ['бонусу', 'bonus', 'бонуса'], ['накопичення максимум', 'maximum balance', 'максимум накопления'],
    ['ліміт досягнуто — використайте бонуси, щоб нараховувати далі',
      'limit reached — redeem bonus to keep earning', 'лимит достигнут — спишите бонусы, чтобы начислять дальше'],
    ['Списати', 'Redeem', 'Списать'], ['разом', 'total', 'всего'], ['нараховано', 'earned', 'начислено'],
    ['Ваші знижки', 'Your offers', 'Ваши скидки'],
    ['Поки що немає активних знижок. Вони зʼявляються на день народження та у свята.',
      'There are no active offers yet. New offers appear for birthdays and holidays.',
      'Активных скидок пока нет. Они появляются ко дню рождения и праздникам.'],
    ['Промокоди', 'Promo codes', 'Промокоды'], ['Активних промокодів немає.', 'No active promo codes.', 'Активных промокодов нет.'],
    ['Покупки', 'Purchases', 'Покупки'], ['Покупок ще не було.', 'No purchases yet.', 'Покупок пока не было.'],
    ['Списано бонусів:', 'Bonus redeemed:', 'Списано бонусов:'],
    ['День народження', 'Birthday', 'День рождения'], ['Свято', 'Holiday', 'Праздник'],
    ['Знижка', 'Discount', 'Скидка'], ['Копіювати', 'Copy', 'Копировать'],
    ['Персональний промокод', 'Personal promo code', 'Персональный промокод'],
    ['VIP-клуб', 'VIP Club', 'VIP-клуб'], ['VIP-клуб 💎', 'VIP Club 💎', 'VIP-клуб 💎'],
    ['Діє для всіх учасників клубу', 'Available to all club members', 'Действует для всех участников клуба'],
    ['Діє від замовлення', 'Valid on orders of', 'Действует при заказе от'],
    ['Знижка на день народження', 'Birthday discount', 'Скидка ко дню рождения'],
    ['Вже отримана цього року. Промокод — у вкладці «Покупки».',
      'Already claimed this year. Find the promo code under Purchases.',
      'Уже получена в этом году. Промокод находится в разделе «Покупки».'],
    ['Вкажіть дату народження — ми запишемо її один раз, і надалі знижка буде приходити сама. Діє',
      'Enter your date of birth once to receive this offer automatically in the future. Valid for',
      'Укажите дату рождения один раз, и в дальнейшем скидка будет появляться автоматически. Действует'],
    ['Отримати знижку', 'Get discount', 'Получить скидку'], ['чекає на вас', 'is ready for you', 'ждёт вас'],
    ['Діє до', 'Valid through', 'Действует до'], ['Стане доступною', 'Available starting', 'Станет доступна'],
    ['і діятиме', 'and will be valid for', 'и будет действовать'],

    ['Термін вичерпано', 'Expired', 'Срок истёк'], ['щойно', 'just now', 'только что'],
    ['хв', 'min', 'мин'], ['год', 'hr', 'ч'], ['дн', 'days', 'дн'],
    ['день', 'day', 'день'], ['дні', 'days', 'дня'], ['днів', 'days', 'дней'],
    ['клієнт', 'customer', 'клиент'], ['клієнти', 'customers', 'клиента'], ['клієнтів', 'customers', 'клиентов'],

    // Shared administration UI. Store content (product captions and customer
    // names) is intentionally left as authored data; controls and status text
    // are localized.
    ['Заявки', 'Requests', 'Заявки'], ['Акції', 'Campaigns', 'Акции'], ['Бонуси', 'Rewards', 'Бонусы'],
    ['Популярне', 'Popular', 'Популярное'], ['Прибуток', 'Profit', 'Прибыль'],
    ['Клієнти', 'Customers', 'Клиенты'], ['Контент', 'Content', 'Контент'], ['Команда', 'Team', 'Команда'],
    ['Кабінет · супер-адмін', 'Admin · super admin', 'Кабинет · суперадмин'],
    ['Кабінет · адмін', 'Admin · admin', 'Кабинет · админ'],
    ['DEMO — публікації симулюються', 'DEMO — posts are simulated', 'DEMO — публикации симулируются'],
    ['Опублікувати товар', 'Publish item', 'Опубликовать товар'], ['Додати покупку', 'Add purchase', 'Добавить покупку'],
    ['Нова акція', 'New campaign', 'Новая акция'], ['Додати каталог', 'Add catalog', 'Добавить каталог'],
    ['Опублікувати', 'Publish', 'Опубликовать'], ['Додати', 'Add', 'Добавить'], ['Зберегти', 'Save', 'Сохранить'],
    ['Створити', 'Create', 'Создать'], ['Змінити', 'Edit', 'Изменить'], ['Видати', 'Issue', 'Выдать'],
    ['Назва', 'Name', 'Название'], ['Назва (необовʼязково)', 'Name (optional)', 'Название (необязательно)'],
    ['Назва у вітрині', 'Storefront name', 'Название в витрине'], ['Опис', 'Description', 'Описание'],
    ['Канал', 'Channel', 'Канал'], ['Емодзі', 'Emoji', 'Эмодзи'], ['Ціна', 'Price', 'Цена'],
    ['Валюта', 'Currency', 'Валюта'], ['Артикул', 'Item number', 'Артикул'], ['Коментар', 'Note', 'Комментарий'],
    ['Тип знижки', 'Discount type', 'Тип скидки'], ['Тип', 'Type', 'Тип'], ['Розмір', 'Amount', 'Размер'],
    ['Мінімальне замовлення, $', 'Minimum order, $', 'Минимальный заказ, $'],
    ['Максимум накопичення, $', 'Maximum balance, $', 'Максимум накопления, $'],
    ['Скільки днів діє', 'Validity, days', 'Срок действия, дней'], ['Діє, днів', 'Valid for, days', 'Действует, дней'],
    ['Знижка активна', 'Discount active', 'Скидка активна'], ['Свято активне', 'Holiday active', 'Праздник активен'],
    ['Місяць', 'Month', 'Месяц'], ['День', 'Day', 'День'], ['Початок', 'Start', 'Начало'], ['Кінець', 'End', 'Конец'],
    ['Нове свято', 'New holiday', 'Новый праздник'], ['Додати свято', 'Add holiday', 'Добавить праздник'],
    ['Картка позиції', 'Item card', 'Карточка товара'], ['Сховати з вітрини', 'Hide from storefront', 'Скрыть из витрины'],
    ['Собівартість замовлення', 'Order cost', 'Себестоимость заказа'],
    ['Скільки витрачено разом, $', 'Total cost, $', 'Общие затраты, $'],
    ['Нове правило знижки', 'New discount rule', 'Новое правило скидки'],
    ['Знижка, %', 'Discount, %', 'Скидка, %'], ['Знижка, $', 'Discount, $', 'Скидка, $'],
    ['Аудиторія — мінімальний рівень', 'Audience — minimum tier', 'Аудитория — минимальный уровень'],
    ['Усі клієнти', 'All customers', 'Все клиенты'], ['Повторювати щороку', 'Repeat yearly', 'Повторять ежегодно'],
    ['Клієнт', 'Customer', 'Клиент'], ['Товар', 'Item', 'Товар'], ['Сума', 'Amount', 'Сумма'],
    ['Собівартість, $', 'Cost, $', 'Себестоимость, $'], ['Дата народження у базі', 'Date of birth on file', 'Дата рождения в базе'],
    ['Оновити дату', 'Update date', 'Обновить дату'], ['Причина', 'Reason', 'Причина'],
    ['Видати промокод', 'Issue promo code', 'Выдать промокод'], ['Нова', 'New', 'Новая'],
    ['День', 'Day', 'День'], ['Тиждень', 'Week', 'Неделя'], ['Місяць', 'Month', 'Месяц'], ['Рік', 'Year', 'Год'],
    ['Уся історія', 'All history', 'Вся история'], ['Звіт', 'Report', 'Отчёт'],
    ['Кампанії', 'Campaigns', 'Кампании'], ['Картки з каналів', 'Channel items', 'Карточки из каналов'],
    ['Заявки від клієнтів', 'Customer requests', 'Заявки клиентов'], ['Заявок ще немає.', 'No requests yet.', 'Заявок пока нет.'],
    ['Готові акції', 'Campaign templates', 'Готовые акции'], ['Запущені акції', 'Active campaigns', 'Запущенные акции'],
    ['Свята', 'Holidays', 'Праздники'], ['Сезони', 'Seasons', 'Сезоны'], ['Своя', 'Custom', 'Своя'],
    ['Своя акція', 'Custom campaign', 'Своя акция'], ['Порожня форма: дати й умови задаються з нуля.', 'Blank form: set dates and conditions from scratch.', 'Пустая форма: даты и условия задаются с нуля.'],
    ['Різдвяна знижка', 'Christmas offer', 'Рождественская скидка'], ['Новорічна знижка', "New Year's offer", 'Новогодняя скидка'],
    ['Великодня знижка', 'Easter offer', 'Пасхальная скидка'], ['8 Березня', "International Women's Day", '8 Марта'],
    ['День закоханих', "Valentine's Day", 'День святого Валентина'], ['Чорна пʼятниця', 'Black Friday', 'Чёрная пятница'],
    ['Літній розпродаж', 'Summer sale', 'Летняя распродажа'], ['Зимовий розпродаж', 'Winter sale', 'Зимняя распродажа'],
    ['Весняне оновлення', 'Spring refresh', 'Весеннее обновление'], ['Осіння колекція', 'Fall collection', 'Осенняя коллекция'],
    ['Перше замовлення', 'First order', 'Первый заказ'], ['Постійний клієнт', 'Returning customer', 'Постоянный клиент'],
    ['VIP за сумою покупок', 'VIP by lifetime spend', 'VIP по сумме покупок'], ['Повернути сплячих', 'Win back inactive customers', 'Вернуть неактивных'],
    ['Новачок клубу', 'New club member', 'Новичок клуба'], ['Купував цього місяця', 'Purchased this month', 'Покупал в этом месяце'],
    ['Дві покупки за місяць', 'Two purchases in a month', 'Две покупки за месяц'],
    ['Найдовший подарунковий сезон у році — вікно ширше за сам день.', 'The longest gifting season of the year, with a wider campaign window.', 'Самый длинный подарочный сезон года — период шире одного дня.'],
    ['Коротке вікно навколо 31 грудня, коли купують собі, а не в подарунок.', 'A short window around December 31, when customers shop for themselves.', 'Короткий период вокруг 31 декабря, когда покупают для себя.'],
    ['Дата рухома — рахується щороку сама, за православною пасхалією.', 'The date is calculated automatically each year using the Orthodox calendar.', 'Плавающая дата рассчитывается автоматически по православной пасхалии.'],
    ['Найсильніший день року для подарунків у цій категорії.', 'The strongest gifting day of the year for this category.', 'Самый сильный подарочный день года для этой категории.'],
    ['Купують чоловіки і купують швидко — вікно коротке, знижка помітна.', 'Customers buy quickly, so the window is short and the offer is clear.', 'Покупают быстро — период короткий, скидка заметная.'],
    ['Дата рухома (четверта пʼятниця листопада) — рахується сама.', 'The fourth Friday in November is calculated automatically.', 'Четвёртая пятница ноября рассчитывается автоматически.'],
    ['Червень–серпень: розвантажити колекцію до осіннього завозу.', 'June–August: clear the collection before fall arrivals.', 'Июнь–август: разгрузить коллекцию перед осенним завозом.'],
    ['Грудень–лютий, найдовший сезон верхнього одягу.', 'December–February, the longest outerwear season.', 'Декабрь–февраль, самый длинный сезон верхней одежды.'],
    ['Березень–травень, коли гардероб міняють на легший.', 'March–May, when customers switch to a lighter wardrobe.', 'Март–май, когда гардероб меняют на более лёгкий.'],
    ['Вересень–листопад, під завіз нового сезону.', 'September–November, timed for new-season arrivals.', 'Сентябрь–ноябрь, к завозу нового сезона.'],
    ['Тим, хто в клубі, але ще нічого не купив — найдорожчий крок у воронці.', 'For club members who have not purchased yet — the hardest conversion step.', 'Для участников клуба без покупок — самый сложный шаг воронки.'],
    ['Персональна знижка тим, у кого ДН найближчими двома тижнями.', 'A personal offer for birthdays in the next two weeks.', 'Персональная скидка тем, у кого день рождения в ближайшие две недели.'],
    ['Від трьох покупок — тим, кого варто утримати, а не залучити.', 'For customers with three or more purchases who are worth retaining.', 'Для клиентов с тремя и более покупками, которых важно удержать.'],
    ['Від $5000 сукупно. Ця знижка окупається однією покупкою.', 'For $5,000+ lifetime spend. One purchase can cover this offer.', 'Для суммы покупок от $5 000. Скидка окупается одной покупкой.'],
    ['Купував, але не за останні 90 днів. Тим, хто вже знає товар.', 'Purchased before, but not in the last 90 days.', 'Покупал раньше, но не за последние 90 дней.'],
    ['У клубі не довше двох тижнів — поки цікавість ще свіжа.', 'Joined within the last two weeks while interest is still fresh.', 'В клубе не дольше двух недель, пока интерес ещё свежий.'],
    ['Ще тепла аудиторія — допродаж, поки замовлення в дорозі.', 'A warm audience for an add-on while the order is in transit.', 'Тёплая аудитория для допродажи, пока заказ в пути.'],
    ['Приклад складнішої умови: період І кількість покупок у ньому.', 'Example of a compound condition: period AND purchase count.', 'Пример сложного условия: период И количество покупок.'],
    ['Кешбек за покупку', 'Purchase bonus', 'Бонус за покупку'], ['увімкнено', 'enabled', 'включено'],
    ['Кожне свято налаштовується так само: сума в $ або відсоток, мінімальне замовлення і скільки днів діє.', 'Each holiday uses the same settings: fixed or percentage discount, minimum order and validity.', 'Для каждого праздника задаются сумма или процент, минимальный заказ и срок действия.'],
    ['Новий рік', "New Year's Day", 'Новый год'], ['Різдво (за старим стилем)', 'Orthodox Christmas', 'Рождество (старый стиль)'],
    ['Великдень (орієнтовно)', 'Easter (estimated)', 'Пасха (ориентировочно)'],
    ['День Незалежності України', 'Ukrainian Independence Day', 'День Независимости Украины'],
    ['Кіберпонеділок', 'Cyber Monday', 'Киберпонедельник'], ['Різдво (за новим стилем)', 'Christmas', 'Рождество (новый стиль)'],
    ['Заявки на знижку ДН', 'Birthday discount requests', 'Заявки на скидку ко дню рождения'],
    ['Заявок ще не було.', 'No requests yet.', 'Заявок пока не было.'],
    ['Що цікавить клієнтів', 'Customer interest', 'Интерес клиентов'], ['Весь час', 'All time', 'Всё время'],
    ['у примірочну', 'added to fitting room', 'в примерочную'], ['заявок', 'requests', 'заявок'],
    ['Топ позицій', 'Top items', 'Топ позиций'], ['За цей період нічого не додавали.', 'Nothing was added during this period.', 'За этот период ничего не добавляли.'],
    ['виручка', 'revenue', 'выручка'], ['витрати', 'costs', 'расходы'], ['чистий', 'net', 'чистая'],
    ['Без собівартості', 'Missing cost', 'Без себестоимости'], ['Ввести', 'Enter', 'Ввести'],
    ['По замовленнях', 'By order', 'По заказам'], ['нема даних', 'no data', 'нет данных'],
    ['Канали', 'Channels', 'Каналы'], ['Синхронізувати всі', 'Sync all', 'Синхронизировать все'],
    ['Додати людину', 'Add team member', 'Добавить сотрудника'],
    ['Пост зʼявиться і в каналі Telegram, і у стрічці застосунку.', 'The item will appear in both the Telegram channel and the app feed.', 'Товар появится и в Telegram-канале, и в ленте приложения.'],
    ['Нова колекція, доставка 10–14 днів', 'New collection, delivery in 10–14 days', 'Новая коллекция, доставка 10–14 дней'],
    ['Сума перераховується в USD — бонус рахується від неї. Якщо собівартість не ввести зараз, нагадаємо наступного дня.', 'The amount is converted to USD for bonus calculation. If cost is omitted, a reminder will be sent tomorrow.', 'Сумма пересчитывается в USD для начисления бонуса. Если не указать себестоимость, завтра придёт напоминание.'],
    ['скільки віддали в Китаї', 'amount paid in China', 'сколько заплатили в Китае'],
    ['Назва акції', 'Campaign name', 'Название акции'], ['Мін. замовлення, $', 'Minimum order, $', 'Минимальный заказ, $'],
    ['% — відсоток', '% — percentage', '% — процент'], ['$ — фіксована сума', '$ — fixed amount', '$ — фиксированная сумма'],
    ['Порожній кінець — акція без дати завершення.', 'Leave the end date blank for an open-ended campaign.', 'Оставьте дату окончания пустой для бессрочной акции.'],
    ['Кому', 'Audience', 'Аудитория'], ['Ще жодної покупки (перше замовлення)', 'No purchases yet (first order)', 'Ещё нет покупок (первый заказ)'],
    ['Покупок від', 'Minimum purchases', 'Покупок от'], ['Покупок до', 'Maximum purchases', 'Покупок до'],
    ['Промокод діє, днів', 'Promo code validity, days', 'Промокод действует, дней'],
    ['Сума покупок від, $', 'Lifetime spend from, $', 'Сумма покупок от, $'], ['Сума покупок до, $', 'Lifetime spend to, $', 'Сумма покупок до, $'],
    ['Купував за останні, днів', 'Purchased within, days', 'Покупал за последние, дней'],
    ['…і стільки разів за цей період', '…minimum purchases in that period', '…минимум покупок за этот период'],
    ['Не купував уже, днів', 'Inactive for, days', 'Не покупал уже, дней'],
    ['День народження протягом, днів', 'Birthday within, days', 'День рождения в течение, дней'],
    ['У клубі не довше, днів', 'Joined within, days', 'В клубе не дольше, дней'],
    ['Лише ті, чия дата народження відома', 'Only customers with a known birthday', 'Только клиенты с известной датой рождения'],
    ['Місто', 'City', 'Город'], ['Купував з каталогу', 'Purchased from catalog', 'Покупал из каталога'],
    ['— будь-який —', '— any —', '— любой —'], ['Створити акцію', 'Create campaign', 'Создать акцию'],
    ['Канал має бути публічним — застосунок читає його відкриту сторінку. Після додавання натисніть «Синхронізувати», щоб підтягнути позиції.',
      'The channel must be public. The app reads its public page; after adding it, tap Sync to import items.',
      'Канал должен быть публичным. Приложение читает его открытую страницу; после добавления нажмите «Синхронизировать».'],
    ['Великдень', 'Easter', 'Пасха'], ['Імʼя', 'Name', 'Имя'], ['Роль', 'Role', 'Роль'],
    ['Адмін — клієнти, каталог, покупки', 'Admin — customers, catalog and purchases', 'Админ — клиенты, каталог и покупки'],
    ['Супер-адмін — усе, разом з акціями й командою', 'Super admin — full access, including campaigns and team', 'Суперадмин — полный доступ, включая акции и команду'],
    ['Id можна дізнатись через @userinfobot. Людина має хоча б раз відкрити бота, інакше повідомлення до неї не дійдуть.',
      'Find the ID via @userinfobot. The person must open the bot at least once to receive messages.',
      'ID можно узнать через @userinfobot. Человек должен хотя бы раз открыть бота, чтобы получать сообщения.'],
    ['«Синхронізувати» зчитує канал і вирівнює каталог під нього: нові пости додаються, змінені оновлюються, знятих більше не видно. Сам канал не змінюється — застосунок його лише читає. Виправлені вручну назви та приховані картки синхронізація не перезаписує.',
      '“Sync” reads the channel and matches the catalog to it: new posts are added, edits are updated and removed posts disappear. The channel itself is read-only. Manually edited names and hidden cards are preserved.',
      '«Синхронизировать» считывает канал и обновляет каталог: новые публикации добавляются, изменения обновляются, удалённые исчезают. Сам канал не меняется. Ручные названия и скрытые карточки сохраняются.'],
    ['Супер-адмін бачить і змінює все: акції, бонуси, прибуток, налаштування і склад команди. Адмін працює з клієнтами — заявки, картки каталогу, покупки, синхронізація каналів — але не бачить собівартості й не призначає знижок.',
      'A super admin can manage campaigns, rewards, profit, settings and the team. An admin handles customers, requests, catalog items, purchases and channel sync, but cannot see costs or assign discounts.',
      'Суперадмин управляет акциями, бонусами, прибылью, настройками и командой. Админ работает с клиентами, заявками, карточками, покупками и синхронизацией, но не видит себестоимость и не назначает скидки.'],
    ['Постів із каналів ще немає', 'No channel posts yet', 'Публикаций из каналов пока нет'],
    ['Кампаній немає.', 'No campaigns.', 'Кампаний нет.'],
    ['Натисніть період, щоб побудувати звіт.', 'Select a period to build a report.', 'Выберите период, чтобы построить отчёт.'],
    ['Тут для вас поки нічого немає.', 'There is nothing here for you yet.', 'Здесь для вас пока ничего нет.'],
    ['Синхронізувати', 'Sync', 'Синхронизировать'], ['Зробити стрічкою', 'Use as feed', 'Сделать лентой'],
    ['без @username', 'no @username', 'без @username'], ['стрічка', 'feed', 'лента'], ['прихована', 'hidden', 'скрыта'],

    ['Немає зʼєднання з сервером', 'Cannot connect to the server', 'Нет соединения с сервером'],
    ['Сервер недоступний. Спробуйте пізніше.', 'The server is unavailable. Try again later.', 'Сервер недоступен. Попробуйте позже.'],
    ['Не вдалося завантажити', 'Could not load', 'Не удалось загрузить'], ['Помилка', 'Error', 'Ошибка'],
    ['Не вдалося скопіювати', 'Could not copy', 'Не удалось скопировать'],
    ['скопійовано', 'copied', 'скопирован'], ['Додано в примірочну', 'Added to fitting room', 'Добавлено в примерочную'],
    ['Вже у примірочній', 'Already in fitting room', 'Уже в примерочной'],
    ['Спочатку приєднайтесь до клубу', 'Join the club first', 'Сначала вступите в клуб'],
    ['Ми звʼяжемося з вами щодо цього товару', 'We will contact you about this item', 'Мы свяжемся с вами по этому товару'],
    ['Вітаємо у клубі!', 'Welcome to the club!', 'Добро пожаловать в клуб!'],
    ['Статус заявки оновлено', 'Request status updated', 'Статус заявки обновлён'],
    ['Роль змінено', 'Role updated', 'Роль изменена'], ['Доступ вимкнено', 'Access disabled', 'Доступ отключён'],
    ['Доступ увімкнено', 'Access enabled', 'Доступ включён'], ['Правило збережено', 'Rule saved', 'Правило сохранено'],
    ['Свято збережено', 'Holiday saved', 'Праздник сохранён'], ['Свято додано', 'Holiday added', 'Праздник добавлен'],
    ['Картку оновлено', 'Item updated', 'Карточка обновлена'], ['Дату народження оновлено', 'Date of birth updated', 'Дата рождения обновлена'],
    ['Опубліковано в каналі', 'Published to channel', 'Опубликовано в канале'],
    ['Опубліковано (демо-режим)', 'Published (demo mode)', 'Опубликовано (деморежим)'],
    ['Правило створено', 'Rule created', 'Правило создано'], ['Додано', 'Added', 'Добавлено'],
    ['Примірочна порожня.', 'The fitting room is empty.', 'Примерочная пуста.'],
    ['Знижка на день народження зараз вимкнена.', 'Birthday discounts are currently unavailable.', 'Скидка ко дню рождения сейчас отключена.'],
    ['Вкажіть дату народження у форматі ДД.ММ.РРРР.', 'Enter your date of birth in MM/DD/YYYY format.', 'Укажите дату рождения в формате ДД.ММ.ГГГГ.'],
    ['Дата не збігається з тією, що вже є у нас. Напишіть менеджеру — перевіримо.', 'This date does not match our records. Message the manager so we can verify it.', 'Дата не совпадает с данными в нашей базе. Напишите менеджеру — мы проверим.'],
    ['у цього каналу немає @username — читати нічого', 'This channel has no @username to read', 'У этого канала нет @username — нечего считывать'],
    ['потрібен @username каналу', 'A channel @username is required', 'Нужен @username канала'],
    ['Calvin Klein сукня', 'Calvin Klein dress', 'Платье Calvin Klein'],
    ['Michael Kors сумка', 'Michael Kors bag', 'Сумка Michael Kors'],
  ];

  function detectedLocale() {
    try {
      var saved = window.localStorage.getItem(STORAGE_KEY);
      if (SUPPORTED.indexOf(saved) !== -1) return saved;
    } catch (e) { /* storage may be disabled */ }
    var telegramCode = window.W2B && window.W2B.tg && window.W2B.tg.languageCode;
    var browserCode = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    return /^ru(?:-|$)/i.test(telegramCode || browserCode) ? 'ru' : 'en';
  }

  var locale = detectedLocale();
  var indexes = [{}, {}, {}];
  entries.forEach(function (entry) {
    for (var i = 0; i < 3; i++) if (entry[i] && indexes[i][entry[i]] == null) indexes[i][entry[i]] = entry;
  });

  function dynamic(text) {
    var target = locale === 'ru' ? 'ru' : 'en';
    var targetIndex = target === 'ru' ? 2 : 1;
    var term = function (value) {
      var found = indexes[0][value] || indexes[1][value] || indexes[2][value];
      return found ? found[targetIndex] : value;
    };
    var rules = [
      [/^Прибрати фільтр (.+)$/, function (_all, value) {
        return (target === 'ru' ? 'Снять фильтр ' : 'Remove filter ') + term(value);
      }],
      [/^(\d+) позицій, (\d+) клієнтів$/,
        target === 'ru' ? '$1 позиций, $2 клиентов' : '$1 items, $2 customers'],
      [/^(\d+) позицій, (\d+) клієнтів, куплено (\d+)$/,
        target === 'ru' ? '$1 позиций, $2 клиентов, куплено $3' : '$1 items, $2 customers, $3 bought'],
      [/^(\d+) питали$/, target === 'ru' ? '$1 спросили' : '$1 asked'],
      [/^([\d.]+)% питали$/, target === 'ru' ? '$1% спросили' : '$1% asked'],
      [/^(\d+) (позиція|позиції|позицій)$/, target === 'ru' ? '$1 позиции' : '$1 items'],
      [/^([\d.,\s $€₴]+) покупок$/, target === 'ru' ? '$1 покупок' : '$1 purchases'],
      [/^Промокод (.+) скопійовано$/, target === 'ru' ? 'Промокод $1 скопирован' : 'Promo code $1 copied'],
      [/^Діє до (.+)\.$/, target === 'ru' ? 'Действует до $1.' : 'Valid through $1.'],
      [/^Стане доступною (.+) і діятиме (\d+) днів\.$/,
        target === 'ru' ? 'Станет доступна $1 и будет действовать $2 дней.' : 'Available starting $1 and valid for $2 days.'],
      [/^За запитом «(.+)» нічого не знайшли$/,
        target === 'ru' ? 'По запросу «$1» ничего не найдено' : 'No results for “$1”'],
      [/^Відправити (.+)$/, target === 'ru' ? 'Отправить $1' : 'Send to $1'],
      [/^Повідомлення (.+)$/, target === 'ru' ? 'Сообщение $1' : 'Message to $1'],
      [/^Або напишіть (.+) напряму:$/,
        target === 'ru' ? 'Или напишите $1 напрямую:' : 'Or message $1 directly:'],
      [/^Написати (.+) напряму$/, target === 'ru' ? 'Написать $1 напрямую' : 'Message $1 directly'],
      [/^(.+) отримає це повідомлення разом зі списком обраних позицій\.$/,
        target === 'ru' ? '$1 получит это сообщение со списком выбранных позиций.' : '$1 will receive this message with your selected items.'],
      [/^Дякуємо! Ваш запит уже в роботі — (.+) звʼяжеться з вами найближчим часом\.$/,
        target === 'ru' ? 'Спасибо! Ваш запрос уже в работе — $1 свяжется с вами в ближайшее время.' : 'Thank you! Your request is already being handled — $1 will contact you shortly.'],
      [/^Вашу знижку (.+) враховано$/, target === 'ru' ? 'Ваша скидка $1 учтена' : 'Your $1 discount has been applied'],
      [/^Правило: покупка від (.+) → (.+) бонусу(?:, накопичення максимум (.+))?$/,
        function (_all, min, reward, cap) {
          if (target === 'ru') return 'Правило: покупка от ' + min + ' → бонус ' + reward + (cap ? ', максимум накопления ' + cap : '');
          return 'Rule: purchase of ' + min + ' → ' + reward + ' bonus' + (cap ? ', maximum balance ' + cap : '');
        }],
      [/^з (.+)$/, target === 'ru' ? 'из $1' : 'of $1'],
      [/^Списати (.+)$/, target === 'ru' ? 'Списать $1' : 'Redeem $1'],
      [/^🎂 Знижка (.+) від замовлення (.+) чекає на вас$/,
        target === 'ru' ? '🎂 Скидка $1 при заказе от $2 уже доступна' : '🎂 $1 discount on orders of $2 is ready for you'],
      [/^🎂 Знижка (.+) чекає на вас$/, target === 'ru' ? '🎂 Скидка $1 уже доступна' : '🎂 $1 discount is ready for you'],
      [/^Знижка (.+) на день народження$/, target === 'ru' ? 'Скидка $1 ко дню рождения' : '$1 birthday discount'],
      [/^(.+)-клієнт · до (.+)$/, target === 'ru' ? '$1-клиент · до $2' : '$1 customer · through $2'],
      [/^Списано бонусів: (.+) · нараховано: (.+)$/, target === 'ru' ? 'Списано бонусов: $1 · начислено: $2' : 'Bonus redeemed: $1 · earned: $2'],
      [/^Обрані позиції \((\d+)\)$/, target === 'ru' ? 'Выбранные позиции ($1)' : 'Selected items ($1)'],
      [/^(.+) — без кінця$/, target === 'ru' ? '$1 — без окончания' : '$1 — no end date'],
      [/^(.+) за кожну покупку від замовлення (.+), накопичення максимум (.+)$/,
        target === 'ru' ? '$1 за каждую покупку от $2, максимум накопления $3' : '$1 for every purchase of $2, maximum balance $3'],
      [/^(.+) від замовлення (.+), діє (\d+) дн\.$/,
        target === 'ru' ? '$1 при заказе от $2, действует $3 дней.' : '$1 on orders of $2, valid for $3 days.'],
      [/^(.+) · діє (\d+) дн$/, target === 'ru' ? '$1 · действует $2 дней' : '$1 · valid for $2 days'],
      [/^(.+) · позицій: (\d+) · прибрали з примірочної: (\d+)$/,
        target === 'ru' ? '$1 · позиций: $2 · убрали из примерочной: $3' : '$1 · items: $2 · removed from fitting room: $3'],
      [/^Маржа (.+) · у прибутку враховано (\d+) з (\d+) замовлень · середній прибуток (.+)$/,
        target === 'ru' ? 'Маржа $1 · в прибыли учтено $2 из $3 заказов · средняя прибыль $4' : 'Margin $1 · $2 of $3 orders included · average profit $4'],
      [/^Без собівартості \((\d+)\)$/, target === 'ru' ? 'Без себестоимости ($1)' : 'Missing cost ($1)'],
      [/^продано (.+) · клієнт заплатив (.+) — введіть, скільки віддали в Китаї$/,
        target === 'ru' ? 'продано $1 · клиент заплатил $2 — укажите затраты в Китае' : 'sold $1 · customer paid $2 — enter China cost'],
      [/^(.+) · клієнт (.+) · закупка (.+)$/, target === 'ru' ? '$1 · клиент $2 · закупка $3' : '$1 · customer $2 · cost $3'],
      [/^(.+) · клієнт (.+) · собівартість не введена$/,
        target === 'ru' ? '$1 · клиент $2 · себестоимость не указана' : '$1 · customer $2 · cost missing'],
      [/^Клієнти \((\d+)\)$/, target === 'ru' ? 'Клиенты ($1)' : 'Customers ($1)'],
      [/^(\d+) покупок · ДН невідомий \(seed\)$/, target === 'ru' ? '$1 покупок · ДР неизвестен (demo)' : '$1 purchases · birthday unknown (demo)'],
      [/^(\d+) покупок · ДН (.+) \(seed\)$/, target === 'ru' ? '$1 покупок · ДР $2 (demo)' : '$1 purchases · birthday $2 (demo)'],
      [/^бонус (.+)$/, target === 'ru' ? 'бонус $1' : 'bonus $1'],
      [/^Синхронізувати всі \((\d+)\)$/, target === 'ru' ? 'Синхронизировать все ($1)' : 'Sync all ($1)'],
      [/^(@.+) · (\d+) поз\. · ще не синхронізовано$/,
        target === 'ru' ? '$1 · $2 поз. · ещё не синхронизировано' : '$1 · $2 items · not synced yet'],
      [/^active · за (\d+) дн до ДН · щороку$/,
        target === 'ru' ? 'активна · за $1 дн. до ДР · ежегодно' : 'active · $1 days before birthday · yearly'],
      [/^Знижку на день народження вже отримано цього року \((.+)\)\.$/,
        target === 'ru' ? 'Скидка ко дню рождения уже получена в этом году ($1).' : 'Birthday discount already claimed this year ($1).'],
      [/^Знижка стане доступною (.+) і діятиме (\d+) днів\.$/,
        target === 'ru' ? 'Скидка станет доступна $1 и будет действовать $2 дней.' : 'The discount will be available on $1 and remain valid for $2 days.'],
      [/^Знижка (.+) ваша! Промокод (.+)\.$/,
        target === 'ru' ? 'Скидка $1 ваша! Промокод: $2.' : 'Your $1 discount is ready! Promo code: $2.'],
      [/^(.+) звʼяжеться з вами дуже скоро 💛$/,
        target === 'ru' ? '$1 свяжется с вами совсем скоро 💛' : '$1 will contact you very soon 💛'],
      [/^ключ «(.+)» вже зайнятий іншим каналом$/,
        target === 'ru' ? 'ключ «$1» уже занят другим каналом' : 'key “$1” is already used by another channel'],
      [/^немає каналу «(.+)»$/, target === 'ru' ? 'нет канала «$1»' : 'channel “$1” does not exist'],
      [/^(.+) бонусу за покупку від (.+), знижка (.+) на день народження від замовлення (.+), і вся стрічка каналу в одному місці\.$/,
        target === 'ru' ? '$1 бонус за покупку от $2, скидка $3 ко дню рождения при заказе от $4, и вся лента канала в одном месте.' : '$1 bonus on a purchase of $2, $3 birthday discount on orders of $4, and the full channel feed in one place.']
    ];
    for (var i = 0; i < rules.length; i++) if (rules[i][0].test(text)) return text.replace(rules[i][0], rules[i][1]);
    return text;
  }

  function translate(value) {
    if (value == null) return '';
    var input = String(value);
    var leading = (input.match(/^\s*/) || [''])[0];
    var trailing = (input.match(/\s*$/) || [''])[0];
    var clean = input.slice(leading.length, input.length - trailing.length);
    if (!clean) return input;
    // Exact phrase matching prevents short unit labels (for example Ukrainian
    // “год”) from ever altering a customer name or a product title.
    var entry = indexes[0][clean] || indexes[1][clean] || indexes[2][clean];
    var translated = entry ? entry[locale === 'ru' ? 2 : 1] : dynamic(clean);
    return leading + translated + trailing;
  }

  function shouldSkip(node) {
    var parent = node.parentElement;
    return !parent || parent.closest('script, style, [data-i18n-skip]');
  }

  function localize(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      if (!shouldSkip(root)) {
        var next = translate(root.nodeValue);
        if (next !== root.nodeValue) root.nodeValue = next;
      }
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    var element = root.nodeType === Node.ELEMENT_NODE ? root : null;
    if (element && element.matches('[data-i18n-skip]')) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (shouldSkip(node)) continue;
      var translated = translate(node.nodeValue);
      if (translated !== node.nodeValue) node.nodeValue = translated;
    }
    var nodes = [];
    if (element) nodes.push(element);
    if (root.querySelectorAll) nodes = nodes.concat(Array.prototype.slice.call(root.querySelectorAll('[placeholder], [aria-label], [title]')));
    nodes.forEach(function (el) {
      ['placeholder', 'aria-label', 'title'].forEach(function (attr) {
        if (!el.hasAttribute(attr)) return;
        var current = el.getAttribute(attr);
        var next = translate(current);
        if (next !== current) el.setAttribute(attr, next);
      });
    });
    document.documentElement.lang = locale === 'ru' ? 'ru' : 'en-US';
  }

  function setLocale(next) {
    if (SUPPORTED.indexOf(next) === -1 || next === locale) return;
    locale = next;
    try { window.localStorage.setItem(STORAGE_KEY, locale); } catch (e) { /* ignore */ }
    document.documentElement.lang = locale === 'ru' ? 'ru' : 'en-US';
    document.dispatchEvent(new CustomEvent('w2b:localechange', { detail: { locale: locale } }));
  }

  var observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      mutation.addedNodes.forEach(localize);
      if (mutation.type === 'characterData') localize(mutation.target);
    });
  });

  window.W2B = window.W2B || {};
  window.W2B.i18n = {
    locale: function () { return locale; },
    languageTag: function () { return locale === 'ru' ? 'ru-RU' : 'en-US'; },
    setLocale: setLocale,
    translate: translate,
    localize: localize,
  };

  localize(document);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
})();
